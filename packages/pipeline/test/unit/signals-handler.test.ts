// The signal handler (#288; A 1.3, A 1.4, A 1.5, A 2.1, A 4.4): target resolution first, then one
// `comment` event per signal plus the event its intent implies, under one `expectedSeq`; attribution
// comments on the ticket and the PR (batch key `comment:{incident}`); and reactions on a message
// with no incident, stored and counted once the incident exists. Runs on the dialect `SNAPWING_DB`
// selects (CI runs both); the engine, the stop, and the fixer start are recording fakes or the real
// stop over fakes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultPlaybook, type Playbook } from '../../src/config/playbook.ts';
import type { EventPayloads, EventType, IncidentEvent, NewEvent } from '../../src/contracts/events.ts';
import type { FixerRunData } from '../../src/contracts/jobs.ts';
import type { IncidentActor } from '../../src/contracts/incident.ts';
import type { Intent } from '../../src/contracts/signals.ts';
import type { OutboxItem } from '../../src/contracts/state.ts';
import type { TapInput, TapOutcome } from '../../src/engine/orchestrator.ts';
import type { FixerDeps } from '../../src/fixer/job.ts';
import { stopIncident } from '../../src/fixer/stop.ts';
import type { WorkspaceMap } from '../../src/map/types.ts';
import type { CachePort } from '../../src/ports/cache.ts';
import type { RunnerPort } from '../../src/ports/runner.ts';
import type { OpenedState, StatePort } from '../../src/ports/state.ts';
import { createKvCache } from '../../src/providers/local/cache.ts';
import type { ReviewVerdict } from '../../src/review/verdict.ts';
import {
  adoptPendingSignals,
  handleSignal,
  NOT_A_BUG_RESOLUTION,
  PENDING_SLOTS,
  pendingKey,
  type SignalDeps,
  type SignalInput,
} from '../../src/signals/handler.ts';
import { recordBotMessage } from '../../src/signals/messages.ts';
import { getEscalationScores } from '../../src/state/projections/index.ts';
import { attributionText, jiraCommentBatchKey, jiraCreateBatchKey, jiraFieldBatchKey } from '../../src/state/projections/outbox/jira.ts';
import { StateStore } from '../../src/state/store.ts';
import { InProcessWorkflow } from '../../src/workflow/inprocess/index.ts';
import { createTestDatabase, TEST_DIALECT, type TestDatabase } from '../helpers/db.ts';

const WS = '01K6WORKSPACE0000000000000';
const INC = '01K6SIGNALINC000000000000A';
const CHANNEL = 'C0FAKEBUGS';
const ANCHOR = '1730000000.000100';
const FIX_PREVIEW = '1730000000.000200';
const PR_CARD = '1730000000.000300';
const STAGING = '1730000000.000400';
const STATUS = '1730000000.000500';
const DEDUPE = '1730000000.000600';
const T0 = Date.parse('2026-10-02T10:00:00.000Z');
const MINUTE = 60_000;
const LINK = 'https://example.slack.com/archives/C0FAKEBUGS/p1730000000000900';

const DANA: IncidentActor = { id: 'U0FAKEDANA', name: 'Dana', role: 'engineer' };
const LEE: IncidentActor = { id: 'U0FAKELEE', name: 'Lee', role: 'engineer' };
const PAT: IncidentActor = { id: 'U0FAKEPAT', name: 'Pat', role: 'reporter' };
const SAM: IncidentActor = { id: 'U0FAKESAM', name: 'Sam', role: 'reporter' };
const OWNER: IncidentActor = { id: 'U0FAKEOWNER', name: 'Olu', role: 'engineer' };

let tdb: TestDatabase;
let state: OpenedState;
let wf: InProcessWorkflow;
let now: number;

beforeEach(async () => {
  tdb = await createTestDatabase();
  now = T0;
  state = await tdb.open({ now: () => new Date(now) });
  wf = new InProcessWorkflow(state);
});

afterEach(async () => {
  await wf.stop();
  await tdb.drop();
});

// Fakes -------------------------------------------------------------------------------------------

interface World {
  deps: SignalDeps;
  claims: { incidentId: string; seq: number }[];
  taps: TapInput[];
  fixerStarts: FixerRunData[];
  /** What the next `handleTap` answers. */
  tapAnswer: TapOutcome;
  cache: CachePort;
}

const MAP: WorkspaceMap = {
  people: [
    { slackId: OWNER.id, handle: 'olu', role: 'engineer', owns: [{ surface: 'web', primary: true }] },
    { slackId: DANA.id, handle: 'dana', role: 'engineer', owns: [] },
    { slackId: LEE.id, handle: 'lee', email: 'lee@example.com', role: 'engineer', owns: [] },
  ],
} as unknown as WorkspaceMap;

function world(opts: { playbook?: Playbook; state?: StatePort } = {}): World {
  const runner: RunnerPort = { runFixer: (job) => Promise.resolve({ runId: job.runId }), cancel: () => Promise.resolve() };
  const fixerDeps: FixerDeps = {
    workspaceId: WS,
    state,
    workflow: wf,
    runner,
    github: { markIncomplete: () => Promise.resolve(), closePr: () => Promise.resolve() },
    config: { harness: { adapter: 'claude-code' } },
    clock: () => new Date(now),
  };
  const cache = createKvCache(state as unknown as StateStore);
  const w: World = {
    claims: [],
    taps: [],
    fixerStarts: [],
    tapAnswer: { accepted: true, resumed: true },
    cache,
    deps: undefined as unknown as SignalDeps,
  };
  w.deps = {
    workspaceId: WS,
    state: opts.state ?? state,
    cache,
    playbook: opts.playbook ?? defaultPlaybook(),
    map: MAP,
    engine: {
      handleClaim: (incidentId, seq) => {
        w.claims.push({ incidentId, seq });
        return Promise.resolve({ commented: false, woke: false });
      },
      handleTap: (tap) => {
        w.taps.push(tap);
        return Promise.resolve(w.tapAnswer);
      },
    },
    stopIncident: (input) => stopIncident(fixerDeps, input),
    startFixer: (input) => {
      w.fixerStarts.push(input);
      return Promise.resolve({ jobId: 'job-1' });
    },
    clock: () => new Date(now),
  };
  return w;
}

// The incident ------------------------------------------------------------------------------------

function ev<T extends EventType>(type: T, payload: EventPayloads[T], extra: { at?: number; incidentId?: string } = {}): NewEvent<T> {
  return {
    workspaceId: WS,
    incidentId: extra.incidentId ?? INC,
    type,
    v: 1,
    source: 'agent',
    occurredAt: new Date(extra.at ?? now).toISOString(),
    payload,
  } as unknown as NewEvent<T>;
}

function captured(incidentId = INC, anchor = ANCHOR): NewEvent<'captured'> {
  return ev(
    'captured',
    {
      kind: 'incident',
      idempotencyKey: `slack-${CHANNEL}-${anchor}`,
      source: 'slack',
      reporter: PAT,
      anchorText: 'Checkout total is blank',
      anchorId: anchor,
      channelId: CHANNEL,
    },
    { at: T0 - MINUTE, incidentId },
  );
}

function toPlanned(level: 0 | 1 | 2 | 3): NewEvent[] {
  return [
    captured(),
    ev('context-assembled', { bundle: { artifactId: '01K6BUNDLE00000000000000001', version: 1 }, includedCount: 1, excludedCount: 0 }),
    ev('resolved', { surfaceId: 'web', componentId: 'checkout', repo: 'github.com/fake-org/web', resolvedBy: 'channel-explicit', confidence: 0.9 }),
    ev('dedupe-checked', { candidates: [], decision: 'none' }),
    ev('planned', {
      action: 'create_issue',
      projectKey: 'WEB',
      issueType: 'Bug',
      summary: 'Checkout total is blank',
      priority: 'Medium',
      labels: ['snapwing'],
      autonomyLevel: level,
    }),
  ];
}

async function append(...events: NewEvent[]): Promise<void> {
  const last = (await state.read(INC)).at(-1)?.seq ?? 0;
  await state.append(INC, events, last);
}

async function filed(level: 0 | 1 | 2 | 3 = 2): Promise<void> {
  await append(...toPlanned(level), ev('filed', { jiraKey: 'WEB-1042' }));
  await postCards();
  await drained();
}

/** Takes the incident to `deployed:staging` with the fixer's PR #77 merged. */
async function onStaging(level: 0 | 1 | 2 | 3 = 2): Promise<void> {
  await filed(level);
  await append(
    ev('fixer-started', { runId: '01K6RUN0000000000000000001', harness: 'claude-code', attempt: 1 }),
    ev('fixer-done', { prNumber: 77, branch: 'fix/WEB-1042', summary: 'Fix the total', testsAdded: [] }),
    ev('pr-opened', { prNumber: 77, branch: 'fix/WEB-1042' }),
    ev('review-passed', { prNumber: 77 }),
    ev('ci-green', { prNumber: 77, headSha: 'abc123' }),
    ev('merged', { prNumber: 77, mergeCommitSha: 'def456', levelAtMergeTime: level }),
    ev('deployed:staging', { commitSha: 'def456' }),
  );
  await drained();
}

async function postCards(): Promise<void> {
  const now = (): Date => new Date(T0);
  for (const [messageId, role] of [
    [FIX_PREVIEW, 'fix-preview'],
    [PR_CARD, 'pr'],
    [STAGING, 'staging-check'],
    [STATUS, 'status'],
    [DEDUPE, 'dedupe'],
  ] as const) {
    await recordBotMessage(state, INC, { platform: 'slack', channel: CHANNEL, messageId, role }, now);
  }
}

/** Acks every pending row, so a test sees only the rows its own signals imply. */
async function drained(): Promise<void> {
  for (const target of ['jira', 'github', 'slack'] as const) {
    const rows = await state.drainOutbox(target, 500);
    if (rows.length > 0) await state.ackOutbox(rows.map((r) => r.id));
  }
}

async function pending(target: 'jira' | 'github'): Promise<OutboxItem[]> {
  return state.drainOutbox(target, 500);
}

async function log(): Promise<IncidentEvent[]> {
  return state.read(INC);
}

async function lastComment(): Promise<IncidentEvent<'comment'>> {
  const c = (await log()).filter((e): e is IncidentEvent<'comment'> => e.type === 'comment').at(-1);
  if (c === undefined) throw new Error('no comment event');
  return c;
}

function signal(intent: Intent, actor: IncidentActor, messageId: string, extra: Partial<SignalInput> = {}): SignalInput {
  return {
    intent,
    confidence: 1,
    source: 'reaction',
    platform: 'slack',
    actor,
    target: { channel: CHANNEL, messageId },
    raw: intent === 'accept' ? '+1' : intent,
    timestamp: new Date(now).toISOString(),
    deepLink: LINK,
    ...extra,
  };
}

// Target gating -----------------------------------------------------------------------------------

describe(`handleSignal: gating (${TEST_DIALECT})`, () => {
  it('a message signal outside any incident thread is dropped and never stored (A 1.2)', async () => {
    const w = world();
    const outcome = await handleSignal(w.deps, signal('claim', DANA, '1730000000.009999', { source: 'message', raw: 'looking' }));
    expect(outcome).toEqual({ handled: false, reason: 'no-target' });
    const key = pendingKey({ platform: 'slack', channel: CHANNEL, messageId: '1730000000.009999' }, 0);
    expect(await w.cache.get(key)).toBeNull();
  });

  it('no intent, and a model-classified message under the confidence floor, do nothing', async () => {
    await filed();
    const w = world();
    expect(await handleSignal(w.deps, signal('none', DANA, ANCHOR))).toEqual({ handled: false, reason: 'no-intent' });
    expect(await handleSignal(w.deps, signal('stop', DANA, ANCHOR, { source: 'message', confidence: 0.6, raw: 'maybe hold off' }))).toEqual({
      handled: false,
      reason: 'low-confidence',
    });
    expect((await log()).some((e) => e.type === 'comment')).toBe(false);
  });

  it('a message in the incident thread resolves to the thread root and quotes the text', async () => {
    await filed();
    const w = world();
    const outcome = await handleSignal(w.deps, signal('claim', DANA, ANCHOR, { source: 'message', raw: 'on it' }));
    expect(outcome).toMatchObject({ handled: true, incidentId: INC, role: 'anchor', effect: 'hold', appended: ['comment', 'claimed'] });
    const rows = (await pending('jira')).filter((r) => r.op === 'add-comment');
    expect(rows.map((r) => r.payload['text'])).toEqual([`@Dana is looking at this as of 10:00 UTC: "on it" (${LINK})`]);
  });
});

// Claims (A 2.1, #291) ----------------------------------------------------------------------------

describe(`handleSignal: claim and release (${TEST_DIALECT})`, () => {
  it("an engineer's claim on the anchor appends claimed with the map role and calls handleClaim", async () => {
    await append(...toPlanned(2));
    await postCards();
    const w = world();
    const outcome = await handleSignal(w.deps, signal('claim', DANA, ANCHOR, { raw: 'eyes' }));
    expect(outcome).toMatchObject({ handled: true, effect: 'hold', appended: ['comment', 'claimed'] });
    const claimed = (await log()).at(-1);
    expect(claimed).toMatchObject({
      type: 'claimed',
      actor: { id: DANA.id, role: 'engineer' },
      source: 'slack',
      payload: { claimerId: DANA.id, expiresAt: new Date(T0 + 4 * 60 * MINUTE).toISOString() },
    });
    expect(w.claims).toEqual([{ incidentId: INC, seq: claimed?.seq }]);
    // Before filing there is no issue to comment on.
    expect(await pending('jira')).toEqual([]);
  });

  it("a claim carries the claimer's map email, and after filing it writes the assignee row keyed field:{incident}:assignee", async () => {
    await filed();
    const w = world();
    await handleSignal(w.deps, signal('claim', LEE, FIX_PREVIEW));
    expect((await log()).at(-1)).toMatchObject({ type: 'claimed', payload: { claimerId: LEE.id, claimerEmail: 'lee@example.com' } });
    const assignee = (await pending('jira')).find((r) => r.op === 'update-fields' && 'fields' in r.payload);
    expect(assignee?.payload).toEqual({ issueKey: 'WEB-1042', fields: { assignee: { email: 'lee@example.com' } } });
    expect(assignee?.batchKey).toBe(jiraFieldBatchKey(INC, 'assignee'));
  });

  it("a reporter's claim is a comment with intent claim, holds nothing, and leaves the ticket comment to the engine", async () => {
    await filed();
    const w = world();
    const outcome = await handleSignal(w.deps, signal('claim', PAT, ANCHOR, { raw: 'eyes' }));
    expect(outcome).toMatchObject({ handled: true, effect: 'comment', appended: ['comment'] });
    const comment = await lastComment();
    expect(comment.payload).toMatchObject({ intent: 'claim', effect: 'comment', target: { role: 'anchor', messageId: ANCHOR } });
    expect(w.claims).toEqual([{ incidentId: INC, seq: comment.seq }]);
    expect((await state.getIncident(INC))?.status).toBe('filed');
    expect(await pending('jira')).toEqual([]);
  });

  it('an engineer claim after filing labels the ticket and writes the attribution comment', async () => {
    await filed();
    const w = world();
    await handleSignal(w.deps, signal('claim', DANA, FIX_PREVIEW));
    const rows = await pending('jira');
    expect(rows.map((r) => [r.op, r.payload['labels'] ?? r.payload['text'] ?? r.payload['customFields']])).toEqual([
      ['add-comment', `@Dana is looking at this as of 10:00 UTC (${LINK})`],
      ['update-fields', { 'Agent Status': 'claimed' }],
      ['add-labels', ['human-claimed']],
    ]);
    expect(rows.find((r) => r.op === 'add-comment')?.batchKey).toBe(jiraCommentBatchKey(INC));
  });

  it('records the actor\'s linked GitHub login on the comment; absent without a link; a failed lookup never blocks the signal (#184)', async () => {
    await filed();
    const lookup = (impl: StatePort['getLinkedIdentity']): StatePort => Object.assign(Object.create(state) as StatePort, { getLinkedIdentity: impl });
    const identity = { workspaceId: WS, chat: 'slack', chatUserId: DANA.id, githubLogin: 'dana-q', githubUserId: 7, accessToken: 'sealed', linkedAt: '', updatedAt: '' } as const;

    await handleSignal(world({ state: lookup(() => Promise.resolve(identity)) }).deps, signal('claim', DANA, FIX_PREVIEW));
    expect((await lastComment()).payload.actorGithubLogin).toBe('dana-q');

    await handleSignal(world({ state: lookup(() => Promise.resolve(null)) }).deps, signal('release', DANA, FIX_PREVIEW));
    expect((await lastComment()).payload).not.toHaveProperty('actorGithubLogin');

    const before = (await log()).length;
    const outcome = await handleSignal(world({ state: lookup(() => Promise.reject(new Error('db down'))) }).deps, signal('claim', DANA, FIX_PREVIEW));
    expect(outcome.handled).toBe(true);
    expect((await log()).length).toBeGreaterThan(before);
    expect((await lastComment()).payload).not.toHaveProperty('actorGithubLogin');
  });

  it('a claim on a message that is not the anchor or a fix preview is recorded only', async () => {
    await filed();
    const w = world();
    const outcome = await handleSignal(w.deps, signal('claim', DANA, PR_CARD));
    expect(outcome).toMatchObject({ effect: 'comment', appended: ['comment'] });
    expect((await state.getIncident(INC))?.status).toBe('filed');
  });

  it('release from the claimer appends released and calls handleClaim; from anyone else it is recorded only', async () => {
    await filed();
    const w = world();
    await handleSignal(w.deps, signal('claim', DANA, ANCHOR));
    now += MINUTE;
    expect(await handleSignal(w.deps, signal('release', LEE, ANCHOR))).toMatchObject({ effect: 'comment', appended: ['comment'] });
    const outcome = await handleSignal(w.deps, signal('release', DANA, ANCHOR, { source: 'message', raw: 'handing off' }));
    expect(outcome).toMatchObject({ effect: 'release', appended: ['comment', 'released'] });
    const released = (await log()).at(-1);
    expect(released).toMatchObject({ type: 'released', payload: { scope: 'claim', claimerId: DANA.id, reason: 'requested' } });
    expect(w.claims.at(-1)).toEqual({ incidentId: INC, seq: released?.seq });
    expect(await state.getClaims(INC)).toEqual([]);
    const texts = (await pending('jira')).filter((r) => r.op === 'add-comment').map((r) => r.payload['text']);
    expect(texts.at(-1)).toBe(`@Dana stepped back from this at 10:01 UTC: "handing off" (${LINK})`);
  });
});

// Stop and not a bug ------------------------------------------------------------------------------

describe(`handleSignal: stop and not-a-bug (${TEST_DIALECT})`, () => {
  it('stop goes through stopIncident with the actor and the text, then records the comment', async () => {
    await filed(2);
    const w = world();
    const outcome = await handleSignal(w.deps, signal('stop', DANA, STATUS, { source: 'message', raw: 'hold off, I think this is the CDN' }));
    expect(outcome).toMatchObject({ handled: true, effect: 'stop', appended: ['comment'] });
    const events = await log();
    const stopped = events.find((e) => e.type === 'stopped');
    expect(stopped).toMatchObject({ actor: { id: DANA.id }, source: 'slack', payload: { reason: 'hold off, I think this is the CDN' } });
    expect(events.at(-1)?.type).toBe('comment');
    const texts = (await pending('jira')).filter((r) => r.op === 'add-comment').map((r) => r.payload['text']);
    expect(texts).toContain(`@Dana stopped the fix in Slack at 10:00 UTC: "hold off, I think this is the CDN" (${LINK})`);
    // Both lines share the batch key, so the projector posts them as one comment (B 7.1).
    expect(new Set((await pending('jira')).filter((r) => r.op === 'add-comment').map((r) => r.batchKey))).toEqual(new Set([jiraCommentBatchKey(INC)]));
  });

  it('a stop the Stop button would refuse (level 0, nothing running) is recorded only', async () => {
    await filed(0);
    const w = world();
    expect(await handleSignal(w.deps, signal('stop', PAT, ANCHOR))).toMatchObject({ effect: 'comment' });
    expect((await log()).some((e) => e.type === 'stopped')).toBe(false);
  });

  it("an engineer's not-a-bug closes the filed issue as Won't Do in the same transaction", async () => {
    await filed(1);
    const w = world();
    const outcome = await handleSignal(w.deps, signal('not-a-bug', DANA, ANCHOR, { raw: 'shrug' }));
    expect(outcome).toMatchObject({ effect: 'not-a-bug', appended: ['comment', 'not-a-bug'] });
    expect((await state.getIncident(INC))?.status).toBe('not-a-bug');
    const rows = await pending('jira');
    expect(rows.find((r) => r.op === 'transition')?.payload).toEqual({ issueKey: 'WEB-1042', to: 'done', resolution: NOT_A_BUG_RESOLUTION });
    expect(rows.filter((r) => r.op === 'add-comment').map((r) => r.payload['text'])).toEqual([`@Dana marked this not a bug in Slack at 10:00 UTC (${LINK})`]);
  });

  it('the reporter may say it is not a bug; another reporter is recorded only', async () => {
    await filed(1);
    const w = world();
    expect(await handleSignal(w.deps, signal('not-a-bug', SAM, ANCHOR))).toMatchObject({ effect: 'comment', appended: ['comment'] });
    expect(await handleSignal(w.deps, signal('not-a-bug', PAT, ANCHOR, { source: 'message', raw: 'user error on my end' }))).toMatchObject({
      effect: 'not-a-bug',
    });
  });

  it("an engineer's reject on the Fix Preview Card is not-a-bug; a reporter's is a comment (A 1.3)", async () => {
    await filed(1);
    const w = world();
    expect(await handleSignal(w.deps, signal('reject', PAT, FIX_PREVIEW))).toMatchObject({ effect: 'comment' });
    expect(await handleSignal(w.deps, signal('reject', DANA, FIX_PREVIEW))).toMatchObject({ effect: 'not-a-bug' });
    const texts = (await pending('jira')).filter((r) => r.op === 'add-comment').map((r) => r.payload['text']);
    expect(texts).toEqual([`@Pat disagreed with the fix preview at 10:00 UTC (${LINK})`, `@Dana marked this not a bug in Slack at 10:00 UTC (${LINK})`]);
  });

  it('not-a-bug before filing drops the queued create-issue row', async () => {
    await append(...toPlanned(2));
    await state.enqueueOutbox({
      id: '01K6CREATEROW0000000000001',
      workspaceId: WS,
      target: 'jira',
      incidentId: INC,
      op: 'create-issue',
      payload: { projectKey: 'WEB' },
      batchKey: jiraCreateBatchKey(INC),
      attempts: 0,
      nextAttempt: new Date(T0).toISOString(),
      createdAt: new Date(T0).toISOString(),
    });
    const w = world();
    expect(await handleSignal(w.deps, signal('not-a-bug', DANA, ANCHOR))).toMatchObject({ effect: 'not-a-bug' });
    expect((await pending('jira')).filter((r) => r.op === 'create-issue')).toEqual([]);
  });

  it('not-a-bug where the lifecycle does not take it (a fix running) is recorded only', async () => {
    await filed(2);
    await append(ev('fixer-started', { runId: '01K6RUN0000000000000000009', harness: 'claude-code', attempt: 1 }));
    const w = world();
    expect(await handleSignal(w.deps, signal('not-a-bug', DANA, ANCHOR))).toMatchObject({ effect: 'comment' });
    expect((await state.getIncident(INC))?.status).toBe('fixing');
  });
});

// Watch (A 4.4) -----------------------------------------------------------------------------------

describe(`handleSignal: watch (${TEST_DIALECT})`, () => {
  it('watch subscribes the actor to the incident and writes no attribution comment', async () => {
    await filed();
    const w = world();
    expect(await handleSignal(w.deps, signal('watch', SAM, STATUS, { raw: 'bell' }))).toMatchObject({ effect: 'watch', appended: ['comment'] });
    expect((await state.getSubscriptions(INC)).map((s) => [s.userId, s.scopeKind, s.channel])).toContainEqual([SAM.id, 'incident', 'thread']);
    expect((await pending('jira')).filter((r) => r.op === 'add-comment')).toEqual([]);
  });
});

// Staging check -----------------------------------------------------------------------------------

describe(`handleSignal: the staging check (${TEST_DIALECT})`, () => {
  it('accept verifies on staging, attributed on the ticket and the PR', async () => {
    await onStaging();
    const w = world();
    expect(await handleSignal(w.deps, signal('accept', PAT, STAGING))).toMatchObject({ effect: 'verify', appended: ['comment', 'verified'] });
    expect((await log()).at(-1)).toMatchObject({ type: 'verified', actor: { id: PAT.id }, payload: { env: 'staging' } });
    const line = `@Pat verified on staging at 10:00 UTC (${LINK})`;
    expect((await pending('jira')).filter((r) => r.op === 'add-comment').map((r) => r.payload['text'])).toEqual([line]);
    const github = await pending('github');
    expect(github.map((r) => [r.op, r.payload, r.batchKey])).toEqual([['add-comment', { repo: 'fake-org/web', prNumber: 77, text: line.replace('@Pat', '**Pat**') }, jiraCommentBatchKey(INC)]]);
  });

  it('accept on a staging check the incident has moved past is recorded, not a verification', async () => {
    await onStaging();
    await append(ev('deployed:production', { commitSha: 'def456' }));
    const w = world();
    expect(await handleSignal(w.deps, signal('accept', PAT, STAGING))).toMatchObject({ effect: 'comment', appended: ['comment'] });
  });

  it('reject reopens: the rejection is stored as a review, the fixer re-enqueued at the next attempt, the ticket back in progress', async () => {
    await onStaging(2);
    const w = world();
    const outcome = await handleSignal(w.deps, signal('reject', PAT, STAGING, { source: 'message', raw: 'still broken' }));
    expect(outcome).toMatchObject({ effect: 'reopen', appended: ['comment'] });
    expect(w.fixerStarts).toHaveLength(1);
    const start = w.fixerStarts[0];
    expect(start).toMatchObject({ incidentId: INC, attempt: 2 });
    const review = await state.getArtifact(start?.reviewArtifact?.artifactId ?? '');
    expect(review.kind).toBe('review');
    const verdict = JSON.parse(review.body.toString()) as ReviewVerdict;
    expect(verdict.verdict).toBe('request-changes');
    expect(verdict.reasons[0]).toContain('"still broken"');

    const rows = await pending('jira');
    expect(rows.map((r) => r.op)).toEqual(['transition', 'add-comment']);
    expect(rows[0]?.payload).toEqual({ issueKey: 'WEB-1042', to: 'in-progress' });
    expect(rows[1]?.payload['text']).toBe(`@Pat says the fix does not work on staging at 10:00 UTC: "still broken" (${LINK}). Reopened: the ticket is back in progress.`);

    // The fixer's start takes the incident from staging back to fixing (B 5 row added by #288).
    await append(ev('fixer-started', { runId: '01K6RUN0000000000000000002', harness: 'claude-code', attempt: 2 }));
    expect((await state.getIncident(INC))?.status).toBe('fixing');
  });

  it('reject at level 0 reopens the ticket but starts no fixer', async () => {
    await onStaging(0);
    const w = world();
    expect(await handleSignal(w.deps, signal('reject', PAT, STAGING))).toMatchObject({ effect: 'reopen' });
    expect(w.fixerStarts).toEqual([]);
    expect((await pending('jira')).map((r) => r.op)).toEqual(['transition', 'add-comment']);
  });
});

// PR card, cards, status ----------------------------------------------------------------------------

describe(`handleSignal: the PR card and the other cards (${TEST_DIALECT})`, () => {
  it("a linked engineer's accept on the PR card is a review note on the ticket and the PR; a reporter's is a comment", async () => {
    await onStaging();
    const w = world();
    expect(await handleSignal(w.deps, signal('accept', DANA, PR_CARD, { githubLinked: true }))).toMatchObject({ effect: 'review-note' });
    expect(await handleSignal(w.deps, signal('accept', DANA, PR_CARD))).toMatchObject({ effect: 'comment' });
    expect(await handleSignal(w.deps, signal('accept', PAT, PR_CARD, { githubLinked: true }))).toMatchObject({ effect: 'comment' });
    now += MINUTE;
    expect(await handleSignal(w.deps, signal('reject', LEE, PR_CARD))).toMatchObject({ effect: 'changes-requested' });
    const texts = (await pending('github')).map((r) => r.payload['text']);
    expect(texts).toEqual([
      `Approved in Slack by **Dana** at 10:00 UTC (${LINK})`,
      `**Dana** agreed with the pull request at 10:00 UTC (${LINK})`,
      `**Pat** agreed with the pull request at 10:00 UTC (${LINK})`,
      `Changes requested in Slack by **Lee** at 10:01 UTC (${LINK})`,
    ]);
  });

  it('accept on the dedupe card taps Link; a tap the card refuses is recorded as a comment', async () => {
    await filed();
    const w = world();
    expect(await handleSignal(w.deps, signal('accept', PAT, DEDUPE))).toMatchObject({ effect: 'link' });
    expect(w.taps).toEqual([{ eventId: INC, card: 'dedupe', choice: 'link', actor: { id: PAT.id, role: 'reporter' } }]);
    w.tapAnswer = { accepted: false, reason: 'not-pending' };
    expect(await handleSignal(w.deps, signal('reject', PAT, DEDUPE))).toMatchObject({ effect: 'comment' });
    expect(w.taps.at(-1)).toMatchObject({ card: 'dedupe', choice: 'create-anyway' });
  });

  it('an engineer accept on the fix preview is Fix it only with reactionsAsButtons on', async () => {
    await filed(1);
    const off = world();
    expect(await handleSignal(off.deps, signal('accept', DANA, FIX_PREVIEW))).toMatchObject({ effect: 'comment' });
    expect(off.taps).toEqual([]);
    const playbook = defaultPlaybook();
    playbook.signals.reactionsAsButtons = true;
    const on = world({ playbook });
    expect(await handleSignal(on.deps, signal('accept', DANA, FIX_PREVIEW))).toMatchObject({ effect: 'fix-tap' });
    expect(on.taps).toEqual([{ eventId: INC, card: 'fix-preview', choice: 'approve_fix', actor: { id: DANA.id, role: 'engineer' } }]);
  });

  it('accept on the status message is an acknowledgement, still attributed (every accept and reject is, A 1.5)', async () => {
    await filed();
    const w = world();
    expect(await handleSignal(w.deps, signal('accept', SAM, STATUS))).toMatchObject({ effect: 'ack' });
    expect(await handleSignal(w.deps, signal('reject', SAM, STATUS))).toMatchObject({ effect: 'reject-stage' });
    const texts = (await pending('jira')).filter((r) => r.op === 'add-comment').map((r) => r.payload['text']);
    expect(texts).toEqual([`@Sam acknowledged the status update at 10:00 UTC (${LINK})`, `@Sam says the latest step did not work at 10:00 UTC (${LINK})`]);
  });
});

// Counting (A 1.4) --------------------------------------------------------------------------------

describe(`handleSignal: counting (${TEST_DIALECT})`, () => {
  it('weights reporters, engineers, and the surface owner; one person counts once', async () => {
    await filed();
    const w = world();
    for (const actor of [PAT, SAM, DANA, OWNER, PAT]) await handleSignal(w.deps, signal('escalate', actor, ANCHOR, { raw: 'fire' }));
    const counts = (await log()).filter((e): e is IncidentEvent<'comment'> => e.type === 'comment').map((e) => e.payload.count?.weight);
    expect(counts).toEqual([1, 1, 1.5, 2, 1]);
    const ctx = (state as unknown as StateStore).ctx;
    const scores = await getEscalationScores(ctx, INC);
    expect(scores.find((s) => s.intent === 'escalate')).toMatchObject({ score: 5.5, uniqueReactors: [DANA.id, OWNER.id, PAT.id, SAM.id].sort() });
    // Counted signals change no state, so they write no attribution comment.
    expect((await pending('jira')).filter((r) => r.op === 'add-comment')).toEqual([]);
  });

  it('accept counts on the anchor only; reject on the anchor counts from engineers only', async () => {
    await filed();
    const w = world();
    await handleSignal(w.deps, signal('accept', PAT, ANCHOR));
    await handleSignal(w.deps, signal('accept', PAT, STATUS));
    await handleSignal(w.deps, signal('reject', PAT, ANCHOR));
    await handleSignal(w.deps, signal('reject', DANA, ANCHOR));
    const comments = (await log()).filter((e): e is IncidentEvent<'comment'> => e.type === 'comment');
    expect(comments.map((e) => [e.payload.intent, e.payload.effect, e.payload.count?.weight])).toEqual([
      ['accept', 'agree', 1],
      ['accept', 'ack', undefined],
      ['reject', 'dispute', undefined],
      ['reject', 'dispute', 1.5],
    ]);
    expect(comments[0]?.payload.count?.windowEndsAt).toBe(new Date(T0 - MINUTE + 2 * 60 * MINUTE).toISOString());
  });

  it('trigger counts on any message Snapwing knows, like escalate', async () => {
    await filed();
    const w = world();
    expect(await handleSignal(w.deps, signal('trigger', PAT, ANCHOR, { raw: 'bug' }))).toMatchObject({ effect: 'count', role: 'anchor' });
    expect(await handleSignal(w.deps, signal('trigger', DANA, STATUS, { source: 'message', raw: 'can someone fix this' }))).toMatchObject({ effect: 'count', role: 'status' });
    const scores = await getEscalationScores((state as unknown as StateStore).ctx, INC);
    expect(scores.find((s) => s.intent === 'trigger')).toMatchObject({ score: 2.5, uniqueReactors: [DANA.id, PAT.id].sort() });
  });

  it('a signal after the window is recorded but not counted', async () => {
    await filed();
    const w = world();
    now = T0 + 3 * 60 * MINUTE;
    await handleSignal(w.deps, signal('escalate', PAT, ANCHOR));
    expect((await lastComment()).payload.count).toBeUndefined();
  });

  it('a removed reaction takes the reactor back out and writes no attribution', async () => {
    await filed();
    const w = world();
    await handleSignal(w.deps, signal('escalate', PAT, ANCHOR));
    await handleSignal(w.deps, signal('escalate', SAM, ANCHOR));
    expect(await handleSignal(w.deps, signal('escalate', SAM, ANCHOR, { source: 'reaction-removed' }))).toMatchObject({ effect: 'lower' });
    const scores = await getEscalationScores((state as unknown as StateStore).ctx, INC);
    expect(scores.find((s) => s.intent === 'escalate')).toMatchObject({ score: 1, uniqueReactors: [PAT.id] });
    await handleSignal(w.deps, signal('accept', SAM, STAGING, { source: 'reaction-removed' }));
    expect((await pending('jira')).filter((r) => r.op === 'add-comment')).toEqual([]);
  });
});

// Removal (A 1.6) ------------------------------------------------------------

describe(`handleSignal: removal plans (${TEST_DIALECT})`, () => {
  it('a removed claim releases the claim in the same append and calls handleClaim', async () => {
    await filed();
    const w = world();
    await handleSignal(w.deps, signal('claim', DANA, ANCHOR));
    w.claims.length = 0;
    const out = await handleSignal(w.deps, signal('claim', DANA, ANCHOR, { source: 'reaction-removed' }));
    expect(out).toMatchObject({ handled: true, effect: 'release', appended: ['comment', 'released'] });
    const released = (await log()).filter((e): e is IncidentEvent<'released'> => e.type === 'released');
    expect(released.map((e) => e.payload)).toEqual([{ scope: 'claim', claimerId: DANA.id, reason: 'requested' }]);
    expect(await state.getClaims(INC)).toEqual([]);
    expect(w.claims).toEqual([{ incidentId: INC, seq: (await log()).at(-1)?.seq }]);
  });

  it('a trigger removed within 60 s is recorded as the adapter\'s Stop and never stops a second time', async () => {
    await filed();
    const w = world();
    const stops: unknown[] = [];
    w.deps = {
      ...w.deps,
      stopIncident: (input) => {
        stops.push(input);
        return Promise.resolve({ stopped: true });
      },
    };
    await handleSignal(w.deps, signal('trigger', PAT, ANCHOR));
    now += 30_000;
    const out = await handleSignal(w.deps, signal('trigger', PAT, ANCHOR, { source: 'reaction-removed' }));
    expect(out).toMatchObject({ handled: true, effect: 'stop', appended: ['comment'] });
    expect((await lastComment()).payload.effect).toBe('stop');
    expect(stops).toEqual([]);
  });

  it('a trigger removed after 60 s is recorded only', async () => {
    await filed();
    const w = world();
    await handleSignal(w.deps, signal('trigger', PAT, ANCHOR));
    now += 2 * MINUTE;
    expect(await handleSignal(w.deps, signal('trigger', PAT, ANCHOR, { source: 'reaction-removed' }))).toMatchObject({ effect: 'removed', appended: ['comment'] });
  });
});

// Attribution batching (A 1.5, B 7.1) ---------------------------------------------------------------

describe(`attribution batching (${TEST_DIALECT})`, () => {
  it('signals within 60 s share one batch key, so the projector posts one comment listing them', async () => {
    await onStaging();
    const w = world();
    await handleSignal(w.deps, signal('accept', PAT, STAGING));
    now += 20_000;
    await handleSignal(w.deps, signal('accept', SAM, STAGING));
    now += 20_000;
    await handleSignal(w.deps, signal('accept', DANA, PR_CARD, { githubLinked: true }));
    for (const target of ['jira', 'github'] as const) {
      const rows = (await pending(target)).filter((r) => r.op === 'add-comment');
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((r) => r.batchKey))).toEqual(new Set([jiraCommentBatchKey(INC)]));
      const created = rows.map((r) => Date.parse(r.createdAt));
      expect(Math.max(...created) - Math.min(...created)).toBeLessThan(60_000);
      // The PR comment names people in bold: a display name is not a GitHub login (#167).
      const at = target === 'jira' ? (n: string) => `@${n}` : (n: string) => `**${n}**`;
      expect(rows.map((r) => r.payload['text'])).toEqual([
        `${at('Pat')} verified on staging at 10:00 UTC (${LINK})`,
        `${at('Sam')} verified on staging at 10:00 UTC (${LINK})`,
        `Approved in Slack by ${at('Dana')} at 10:00 UTC (${LINK})`,
      ]);
    }
  });

  it('attributionText leaves out the link when there is none and quotes only message text', () => {
    const base = {
      workspaceId: WS,
      incidentId: INC,
      seq: 9,
      v: 1,
      source: 'teams' as const,
      actor: { id: 'U0FAKEPAT', role: 'reporter' as const },
      occurredAt: '2026-10-02T15:22:41.000Z',
      recordedAt: '2026-10-02T15:22:42.000Z',
      type: 'comment' as const,
    };
    const event: IncidentEvent<'comment'> = {
      ...base,
      payload: { intent: 'accept', platform: 'teams', signalSource: 'reaction', confidence: 1, raw: 'like', effect: 'verify', target: { role: 'staging-check', messageId: 'm1' } },
    };
    expect(attributionText(event)).toBe('@U0FAKEPAT verified on staging at 15:22 UTC');
    expect(attributionText({ ...event, payload: { ...event.payload, effect: 'count' } })).toBeUndefined();
    expect(attributionText({ ...event, payload: { ...event.payload, effect: undefined } as unknown as typeof event.payload })).toBeUndefined();
  });
});

// Before the incident exists (A 1.4) --------------------------------------------------------------

describe(`pending signals (${TEST_DIALECT})`, () => {
  it('reactions on a message with no incident are stored, then counted once the incident is created', async () => {
    const w = world();
    // Five people react before anyone files it; one takes theirs back, one stops, an engineer claims.
    for (const actor of [PAT, SAM, LEE, OWNER]) {
      expect(await handleSignal(w.deps, signal('escalate', actor, ANCHOR, { raw: 'fire' }))).toEqual({ handled: false, reason: 'pending', stored: true });
      now += 1000;
    }
    await handleSignal(w.deps, signal('escalate', SAM, ANCHOR, { source: 'reaction-removed', raw: 'fire' }));
    await handleSignal(w.deps, signal('stop', LEE, ANCHOR));
    await handleSignal(w.deps, signal('claim', DANA, ANCHOR, { raw: 'eyes' }));
    await handleSignal(w.deps, signal('watch', SAM, ANCHOR, { raw: 'bell' }));

    await append(captured());
    await append(...toPlanned(2).slice(1, 3));
    expect(await adoptPendingSignals(w.deps, INC)).toBe(5);
    const comments = (await log()).filter((e): e is IncidentEvent<'comment'> => e.type === 'comment');
    expect(comments.map((e) => [e.actor?.id, e.payload.intent, e.payload.target?.role])).toEqual([
      [PAT.id, 'escalate', 'anchor'],
      [LEE.id, 'escalate', 'anchor'],
      [OWNER.id, 'escalate', 'anchor'],
      [DANA.id, 'claim', 'anchor'],
      [SAM.id, 'watch', 'anchor'],
    ]);
    const scores = await getEscalationScores((state as unknown as StateStore).ctx, INC);
    // The owner weighs 2 once the surface is resolved.
    expect(scores.find((s) => s.intent === 'escalate')).toMatchObject({ score: 4.5, uniqueReactors: [LEE.id, OWNER.id, PAT.id].sort() });
    expect((await log()).some((e) => e.type === 'claimed' && e.actor?.id === DANA.id)).toBe(true);
    expect((await log()).some((e) => e.type === 'stopped')).toBe(false);
    expect(w.claims).toHaveLength(1);
    // Adoption runs once per anchor.
    expect(await adoptPendingSignals(w.deps, INC)).toBe(0);
  });

  it('a signal on the anchor adopts what is pending when the engine never did', async () => {
    const w = world();
    await handleSignal(w.deps, signal('escalate', PAT, ANCHOR));
    await append(captured());
    now += MINUTE;
    expect(await handleSignal(w.deps, signal('escalate', SAM, ANCHOR))).toMatchObject({ handled: true, effect: 'count' });
    const reactors = (await log()).filter((e) => e.type === 'comment').map((e) => e.actor?.id);
    expect(reactors).toEqual([PAT.id, SAM.id]);
  });

  it('stores at most PENDING_SLOTS signals per message and never overwrites one', async () => {
    const w = world();
    const ref = { platform: 'slack' as const, channel: CHANNEL, messageId: ANCHOR };
    for (let n = 0; n < PENDING_SLOTS; n++) {
      await handleSignal(w.deps, signal('escalate', { id: `U0FAKE${String(n)}`, name: `P${String(n)}`, role: 'reporter' }, ANCHOR));
    }
    expect(await handleSignal(w.deps, signal('escalate', PAT, ANCHOR))).toEqual({ handled: false, reason: 'pending', stored: false });
    expect(JSON.parse((await w.cache.get(pendingKey(ref, 0))) ?? '{}')).toMatchObject({ actor: { id: 'U0FAKE0' } });
  });
});

// expectedSeq ---------------------------------------------------------------------------------------

describe(`handleSignal: expectedSeq (${TEST_DIALECT})`, () => {
  it('an append that conflicts decides again on a fresh read', async () => {
    await onStaging();
    let raced = false;
    const racing = new Proxy(state, {
      get(target, prop, receiver) {
        if (prop !== 'transaction') return Reflect.get(target, prop, receiver) as unknown;
        return async <T>(fn: (tx: StatePort) => Promise<T>): Promise<T> => {
          if (!raced) {
            raced = true;
            // The incident leaves staging between the handler's read and its append.
            await append(ev('deployed:production', { commitSha: 'def456' }));
          }
          return target.transaction(fn);
        };
      },
    });
    const w = world({ state: racing });
    const outcome = await handleSignal(w.deps, signal('accept', PAT, STAGING));
    expect(raced).toBe(true);
    // Decided again on deployed:production: no longer a verification.
    expect(outcome).toMatchObject({ handled: true, effect: 'comment', appended: ['comment'] });
    expect((await log()).some((e) => e.type === 'verified')).toBe(false);
  });
});
