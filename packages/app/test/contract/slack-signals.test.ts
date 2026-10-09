// Slack signals (A 1.2, A 1.3, A 1.4): recorded Events API payloads through the real HTTP
// dispatcher, the adapter wrapped by `observeSignals`, and the real signal handler over the dialect
// `SNAPWING_DB` selects. The engine, the stop, and the fixer start are recording fakes in the first
// part; the last test boots the real `compose` (fixtures/e2e/world.ts) to show the engine's
// `onCaptured` adopting reactions that landed before the trigger.

import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultPlaybook } from '@snapwing/pipeline/config/playbook.ts';
import type { EventPayloads, EventType, IncidentEvent, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { FixerRunData } from '@snapwing/pipeline/contracts/jobs.ts';
import { DEMO_GITHUB_TOKEN, GITHUB_API, GitHubWorld, githubHandlers } from '@snapwing/pipeline/demo/msw/github.ts';
import { DEMO_JIRA_EMAIL, DEMO_JIRA_TOKEN, JIRA_BASE, JiraWorld, jiraHandlers } from '@snapwing/pipeline/demo/msw/jira.ts';
import { parseScenario, RecordedModel } from '@snapwing/pipeline/demo/run.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { withValidation } from '@snapwing/pipeline/models/router.ts';
import type { HarnessPort } from '@snapwing/pipeline/ports/harness.ts';
import { createChatLimits, type ChatLimits } from '@snapwing/pipeline/policy/limits.ts';
import type { ClassifyRequest, ModelPort } from '@snapwing/pipeline/ports/model.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { createKvCache } from '@snapwing/pipeline/providers/local/cache.ts';
import { pendingKey, type SignalDeps } from '@snapwing/pipeline/signals/handler.ts';
import { recordBotMessage } from '@snapwing/pipeline/signals/messages.ts';
import { getEscalationScores } from '@snapwing/pipeline/state/projections/index.ts';
import { StateStore } from '@snapwing/pipeline/state/store.ts';
import { createTestDatabase, TEST_DIALECT, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { createSlackAdapter } from '../../src/adapters/slack/adapter.ts';
import { createSlackSignals, observeSignals, slackPermalink, type SlackSignalOutcome } from '../../src/adapters/slack/signals.ts';
import { SLACK_EVENTS_PATH, createSlackTransport } from '../../src/adapters/slack/transport.ts';
import type { SlackWeb } from '../../src/adapters/slack/web.ts';
import { bootComposed, BOT_USER, DEMO_MAP, EXAMPLE_CONFIG, fakeSecrets, SLACK_API, slackSigned, slackWorld } from '../fixtures/e2e/world.ts';
import { createHmac } from 'node:crypto';

const SECRET = 'signing-secret-test';
const BOT = 'U0SNAPWING';
const WS = '01K6WORKSPACE0000000000000';
const INC = '01K6SIGNALINC000000000000A';
const CHANNEL = 'C0FAKEBUGS';
const ANCHOR = '1730000000.000100';
const STAGING = '1730000000.000400';
const STATUS_MSG = '1730000000.000500';
const T0 = 1_730_000_000_000;
const NOW = new Date(T0 + 500_000);
const NOW_S = Math.floor(NOW.getTime() / 1000);

const DANA = 'U0FAKEDANA';
const PAT = 'U0FAKEPAT';

const MAP: WorkspaceMap = {
  org: 'Example',
  updated: '2026-10-02T00:00:00Z',
  surfaces: [{ id: 'web', label: 'Website', repo: 'github.com/fake-org/web', jira: { project: 'WEB', defaultIssueType: 'Bug' }, components: [] }],
  channels: [{ id: CHANNEL, name: 'web-bugs', surface: 'web', triggerEmoji: [] }],
  triggers: { messageActions: [{ label: 'Fix it from here' }], emoji: [{ slack: 'bug', teams: 'bug' }], directMessage: { images: true, text: true } },
  vocabulary: [],
  people: [
    { slackId: DANA, handle: 'dana', role: 'engineer', owns: [] },
    { slackId: PAT, handle: 'pat', role: 'reporter', owns: [] },
  ],
  policies: { autonomy: { default: 1, levels: [], overrides: [] } },
};

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../fixtures/slack/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
}

/** A fixture with fields of its `event` (and its `event_id`) replaced. */
function variant(name: string, eventId: string, event: Record<string, unknown>): Record<string, unknown> {
  const base = fixture(name);
  return { ...base, event_id: eventId, event: { ...(base['event'] as Record<string, unknown>), ...event } };
}

function fakeWeb(): SlackWeb & Record<string, ReturnType<typeof vi.fn>> {
  const web = {
    postMessage: vi.fn(() => Promise.resolve({ channel: CHANNEL, ts: '1730000600.000100' })),
    updateMessage: vi.fn(() => Promise.resolve({ channel: CHANNEL, ts: '1730000600.000100' })),
    postEphemeral: vi.fn(() => Promise.resolve({})),
    pinsAdd: vi.fn(() => Promise.resolve()),
    reactionsAdd: vi.fn(() => Promise.resolve()),
    reactionsGet: vi.fn(() => Promise.resolve({ reactions: [{ name: 'bug', users: [PAT] }], message: { ts: ANCHOR, text: 'Checkout total is blank' } })),
    conversationsHistory: vi.fn(() => Promise.resolve({ messages: [] })),
    conversationsReplies: vi.fn(() =>
      Promise.resolve({
        messages: [
          { ts: ANCHOR, user: PAT, text: 'Checkout total is blank' },
          { ts: '1730000050.000100', user: PAT, text: 'happens on every coupon' },
        ],
      }),
    ),
    conversationsJoin: vi.fn(() => Promise.resolve()),
    usersInfo: vi.fn(),
    usersList: vi.fn(),
    downloadFile: vi.fn(),
    viewsPublish: vi.fn(() => Promise.resolve()),
  };
  return web as unknown as SlackWeb & Record<string, ReturnType<typeof vi.fn>>;
}

function signedRequest(body: string): Request {
  const signature = `v0=${createHmac('sha256', SECRET).update(`v0:${NOW_S}:${body}`).digest('hex')}`;
  return new Request(`http://snapwing.test${SLACK_EVENTS_PATH}`, {
    method: 'POST',
    headers: { 'x-slack-request-timestamp': String(NOW_S), 'x-slack-signature': signature, 'content-type': 'application/json' },
    body,
  });
}

// The dispatcher over a real store ---------------------------------------------------------------

describe(`Slack signals through the dispatcher (${TEST_DIALECT})`, () => {
  let tdb: TestDatabase;
  let state: OpenedState;

  beforeEach(async () => {
    tdb = await createTestDatabase();
    state = await tdb.open({ now: () => NOW });
  });

  afterEach(async () => {
    await tdb.drop();
  });

  function ev<T extends EventType>(type: T, payload: EventPayloads[T], at = T0): NewEvent<T> {
    return { workspaceId: WS, incidentId: INC, type, v: 1, source: 'agent', occurredAt: new Date(at).toISOString(), payload } as unknown as NewEvent<T>;
  }

  async function append(...events: NewEvent[]): Promise<void> {
    const last = (await state.read(INC)).at(-1)?.seq ?? 0;
    await state.append(INC, events, last);
  }

  /** A filed level 2 incident on the anchor, with its staging check and status message recorded. */
  async function filed(): Promise<void> {
    await append(
      ev('captured', {
        kind: 'incident',
        idempotencyKey: `slack-${CHANNEL}-${ANCHOR}`,
        source: 'slack',
        reporter: { id: PAT, name: 'pat', role: 'reporter' },
        anchorText: 'Checkout total is blank',
        anchorId: ANCHOR,
        channelId: CHANNEL,
      }),
      ev('context-assembled', { bundle: { artifactId: '01K6BUNDLE00000000000000001', version: 1 }, includedCount: 1, excludedCount: 0 }),
      ev('resolved', { surfaceId: 'web', componentId: 'checkout', repo: 'github.com/fake-org/web', resolvedBy: 'channel-explicit', confidence: 0.9 }),
      ev('dedupe-checked', { candidates: [], decision: 'none' }),
      ev('planned', { action: 'create_issue', projectKey: 'WEB', issueType: 'Bug', summary: 'Checkout total is blank', priority: 'Medium', labels: ['snapwing'], autonomyLevel: 2 }),
      ev('filed', { jiraKey: 'WEB-1042' }),
    );
    for (const [messageId, role] of [
      [STAGING, 'staging-check'],
      [STATUS_MSG, 'status'],
    ] as const) {
      await recordBotMessage(state, INC, { platform: 'slack', channel: CHANNEL, messageId, role }, () => new Date(T0));
    }
  }

  async function onStaging(): Promise<void> {
    await filed();
    await append(
      ev('fixer-started', { runId: '01K6RUN0000000000000000001', harness: 'claude-code', attempt: 1 }),
      ev('fixer-done', { prNumber: 77, branch: 'fix/WEB-1042', summary: 'Fix the total', testsAdded: [] }),
      ev('pr-opened', { prNumber: 77, branch: 'fix/WEB-1042' }),
      ev('review-passed', { prNumber: 77 }),
      ev('ci-green', { prNumber: 77, headSha: 'abc123' }),
      ev('merged', { prNumber: 77, mergeCommitSha: 'def456', levelAtMergeTime: 2 }),
      ev('deployed:staging', { commitSha: 'def456' }),
    );
  }

  function setup(opts: { model?: ModelPort; limits?: Pick<ChatLimits, 'modelWork'>; guests?: readonly string[] } = {}) {
    const web = fakeWeb();
    const onError = vi.fn();
    const getMap = () => Promise.resolve(MAP);
    const adapter = createSlackAdapter({ web, signingSecret: SECRET, botUserId: BOT, getMap, workspaceDomain: 'example', clock: () => NOW, onError });
    const claims: { incidentId: string; seq: number }[] = [];
    const fixerStarts: FixerRunData[] = [];
    const stops: string[] = [];
    const deps: SignalDeps = {
      workspaceId: WS,
      state,
      cache: createKvCache(state as unknown as StateStore),
      playbook: () => defaultPlaybook(),
      map: getMap,
      engine: {
        handleClaim: (incidentId, seq) => {
          claims.push({ incidentId, seq });
          return Promise.resolve({ commented: false, woke: false });
        },
        handleTap: () => Promise.resolve({ accepted: true, resumed: true }),
      },
      stopIncident: (input) => {
        stops.push(input.incidentId);
        return Promise.resolve({ stopped: true } as never);
      },
      startFixer: (input) => {
        fixerStarts.push(input);
        return Promise.resolve({ jobId: 'job-1' });
      },
      clock: () => NOW,
    };
    const outcomes: SlackSignalOutcome[] = [];
    const signals = createSlackSignals({
      deps,
      getMap,
      botUserId: BOT,
      workspaceDomain: 'example',
      githubLinked: () => Promise.resolve(false),
      web,
      standing: state,
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(opts.limits === undefined ? {} : { limits: opts.limits }),
      ...(opts.guests === undefined ? {} : { access: { membership: (u: string) => Promise.resolve(opts.guests?.includes(u) === true ? ('guest' as const) : ('member' as const)) } }),
      onOutcome: (o) => outcomes.push(o),
      onError,
    });
    const handleInbound = vi.fn(() => Promise.resolve());
    const transport = createSlackTransport({ mode: 'http', adapter: observeSignals(adapter, signals, onError), handleInbound, onAction: vi.fn(), onError });
    const route = transport.routes.find((r) => r.path === SLACK_EVENTS_PATH);
    if (route === undefined) throw new Error('no events route');
    const post = async (body: Record<string, unknown>): Promise<number> => {
      const res = await route.handler(signedRequest(JSON.stringify(body)), { params: {} });
      await signals.idle();
      return res.status;
    };
    return { web, onError, handleInbound, post, outcomes, claims, fixerStarts, stops, signals };
  }

  const comments = async (): Promise<IncidentEvent<'comment'>[]> => (await state.read(INC)).filter((e): e is IncidentEvent<'comment'> => e.type === 'comment');

  it('an ordinary channel message is ignored: never a capture, never a signal', async () => {
    await filed();
    const w = setup();
    expect(await w.post(fixture('signal-channel-message'))).toBe(200);
    expect(w.handleInbound).not.toHaveBeenCalled();
    expect(w.outcomes).toEqual([{ kind: 'ignored', reason: 'not-a-thread-reply' }]);
    expect(await comments()).toEqual([]);
    expect(w.onError).not.toHaveBeenCalled();
  });

  it("a claim: an engineer's eyes on the anchor appends claimed with the map role and wakes the engine", async () => {
    await filed();
    const w = setup();
    expect(await w.post(fixture('signal-reaction-claim'))).toBe(200);
    // Not a trigger emoji: the trigger path ignores it.
    expect(w.handleInbound).not.toHaveBeenCalled();
    expect(w.outcomes).toMatchObject([{ kind: 'signal', intent: 'claim', source: 'reaction', outcome: { handled: true, role: 'anchor', effect: 'hold', appended: ['comment', 'claimed'] } }]);
    const log = await state.read(INC);
    expect(log.at(-1)).toMatchObject({ type: 'claimed', actor: { id: DANA, role: 'engineer' }, payload: { claimerId: DANA } });
    expect((await comments()).at(-1)?.payload).toMatchObject({
      intent: 'claim',
      signalSource: 'reaction',
      raw: 'eyes',
      target: { role: 'anchor', messageId: ANCHOR },
      deepLink: slackPermalink('example', CHANNEL, ANCHOR),
    });
    expect(w.claims).toEqual([{ incidentId: INC, seq: log.at(-1)?.seq }]);
  });

  it('a claim in words: "on it" in the thread goes through the lexicon with the thread root as the target', async () => {
    await filed();
    const w = setup();
    expect(await w.post(fixture('signal-thread-reply'))).toBe(200);
    expect(w.handleInbound).not.toHaveBeenCalled();
    expect(w.outcomes).toMatchObject([{ kind: 'signal', intent: 'claim', source: 'message', outcome: { handled: true, role: 'anchor', effect: 'hold' } }]);
    expect((await comments()).at(-1)?.payload).toMatchObject({
      intent: 'claim',
      signalSource: 'message',
      raw: 'on it',
      deepLink: 'https://example.slack.com/archives/C0FAKEBUGS/p1730000090000100?thread_ts=1730000000.000100&cid=C0FAKEBUGS',
    });
  });

  // The e2e people post through the "Snapwing Test Driver" app with their own user tokens, so
  // Slack stamps `bot_id` and `app_id` on their replies. A person posting through an app is a person.
  it('"on it" from a mapped person posting through an app (bot_id and app_id on the reply) is their claim', async () => {
    await filed();
    const w = setup();
    expect(await w.post(variant('signal-thread-reply', 'Ev0SIGAPP001', { bot_id: 'B0TESTDRIVER', app_id: 'A0TESTDRIVER' }))).toBe(200);
    expect(w.outcomes).toMatchObject([{ kind: 'signal', intent: 'claim', source: 'message', outcome: { handled: true, role: 'anchor', effect: 'hold' } }]);
    expect((await comments()).at(-1)).toMatchObject({ actor: { id: DANA }, payload: { intent: 'claim', raw: 'on it' } });
  });

  it("a staging verification: the reporter's check mark on the staging check appends verified", async () => {
    await onStaging();
    const w = setup();
    expect(await w.post(fixture('signal-reaction-staging'))).toBe(200);
    expect(w.outcomes).toMatchObject([{ kind: 'signal', intent: 'accept', outcome: { handled: true, role: 'staging-check', effect: 'verify', appended: ['comment', 'verified'] } }]);
    expect((await state.read(INC)).at(-1)).toMatchObject({ type: 'verified', actor: { id: PAT, role: 'reporter' }, payload: { env: 'staging' } });
  });

  it('a reply under a message no incident owns is dropped by the handler', async () => {
    const w = setup();
    await w.post(variant('signal-thread-reply', 'Ev0SIGREPLY2', { thread_ts: '1730000003.000100' }));
    expect(w.outcomes).toMatchObject([{ kind: 'signal', intent: 'claim', outcome: { handled: false, reason: 'no-target' } }]);
  });

  it("the bot's own reaction, a bot's reply, a reply that mentions the bot, and an edit are ignored", async () => {
    await filed();
    const w = setup();
    await w.post(variant('signal-reaction-claim', 'Ev0SIGBOT001', { user: BOT }));
    await w.post(variant('signal-thread-reply', 'Ev0SIGBOT002', { user: BOT }));
    await w.post(variant('signal-thread-reply', 'Ev0SIGBOT003', { bot_id: 'B0OTHER', user: 'U0OTHERBOT' }));
    await w.post(variant('signal-thread-reply', 'Ev0SIGBOT004', { text: `<@${BOT}> on it?` }));
    await w.post(variant('signal-thread-reply', 'Ev0SIGBOT005', { subtype: 'message_changed' }));
    expect(w.outcomes.map((o) => (o.kind === 'ignored' ? o.reason : o.kind))).toEqual(['own-reaction', 'bot-message', 'bot-message', 'mentions-bot', 'unsupported-subtype']);
    expect(await comments()).toEqual([]);
  });

  it('a redelivered event is handled once', async () => {
    await filed();
    const w = setup();
    await w.post(fixture('signal-reaction-claim'));
    await w.post(fixture('signal-reaction-claim'));
    expect(w.outcomes.map((o) => o.kind === 'ignored' ? o.reason : o.kind)).toEqual(['signal', 'duplicate']);
    expect((await state.read(INC)).filter((e) => e.type === 'claimed')).toHaveLength(1);
  });

  it('a removed reaction is handed over as reaction-removed', async () => {
    await filed();
    const w = setup();
    await w.post(variant('signal-reaction-escalate', 'Ev0SIGFIRE10', { user: DANA, item: { type: 'message', channel: CHANNEL, ts: ANCHOR } }));
    await w.post(variant('signal-reaction-escalate', 'Ev0SIGFIRE11', { type: 'reaction_removed', user: DANA, item: { type: 'message', channel: CHANNEL, ts: ANCHOR } }));
    expect(w.outcomes).toMatchObject([
      { kind: 'signal', intent: 'escalate', source: 'reaction', outcome: { effect: 'count' } },
      { kind: 'signal', intent: 'escalate', source: 'reaction-removed', outcome: { effect: 'lower' } },
    ]);
    const scores = await getEscalationScores((state as unknown as StateStore).ctx, INC);
    expect(scores.find((s) => s.intent === 'escalate')).toMatchObject({ uniqueReactors: [], score: 0 });
  });

  it('a trigger reaction still reaches handleInbound, and is also counted as a trigger signal', async () => {
    await filed();
    const w = setup();
    await w.post(variant('signal-reaction-escalate', 'Ev0SIGBUG001', { reaction: 'bug' }));
    expect(w.handleInbound).toHaveBeenCalledTimes(1);
    expect(w.outcomes).toMatchObject([{ kind: 'signal', intent: 'trigger', outcome: { handled: true, effect: 'count' } }]);
  });

  it('"keep me posted on the website" in the thread is a standing surface subscription, not a stop or an incident watch', async () => {
    await filed();
    const w = setup();
    await w.post(variant('signal-thread-reply', 'Ev0SIGWATCH1', { user: PAT, text: 'keep me posted on the website' }));
    expect(w.outcomes).toEqual([{ kind: 'standing', changed: true }]);
    const subs = await state.getSubscriptions(INC);
    expect(subs).toMatchObject([{ userId: PAT, scopeKind: 'surface', scopeId: 'web', channel: 'thread', platform: 'slack' }]);
    expect(w.web.postEphemeral).toHaveBeenCalledWith(expect.objectContaining({ channel: CHANNEL, user: PAT, thread_ts: ANCHOR, text: 'Done. I will keep you posted on every incident on Website.' }));
    await w.post(variant('signal-thread-reply', 'Ev0SIGWATCH2', { user: PAT, text: 'stop notifying me on the website' }));
    expect(w.outcomes.at(-1)).toEqual({ kind: 'standing', changed: true });
    expect(w.stops).toEqual([]);
    expect(await comments()).toEqual([]);
    // "keep me posted" with no surface is the incident's watch.
    await w.post(variant('signal-thread-reply', 'Ev0SIGWATCH3', { user: PAT, text: 'keep me posted' }));
    expect(w.outcomes.at(-1)).toMatchObject({ kind: 'signal', intent: 'watch', outcome: { handled: true, effect: 'watch' } });
  });

  it('a guest asking for a standing watch in the thread is told no and nothing is written (#272)', async () => {
    await filed();
    const w = setup({ guests: [PAT] });
    await w.post(variant('signal-thread-reply', 'Ev0SIGGUEST1', { user: PAT, text: 'keep me posted on the website' }));
    expect(w.outcomes).toEqual([{ kind: 'standing', changed: false }]);
    expect(await state.getSubscriptions(INC)).toEqual([]);
    expect(w.web.postEphemeral).toHaveBeenCalledWith(expect.objectContaining({ channel: CHANNEL, user: PAT, thread_ts: ANCHOR, text: 'Status answers are for members of this workspace.' }));
  });

  it('a reply the lexicon misses goes to the model with the earlier thread messages, only in an active incident thread', async () => {
    await filed();
    const requests: ClassifyRequest<unknown>[] = [];
    const model = {
      classify: (req: ClassifyRequest<unknown>) => {
        requests.push(req);
        return Promise.resolve({ value: { intent: 'claim', confidence: 0.9 }, model: 'fake', usage: { inputTokens: 0, outputTokens: 0 } });
      },
    } as unknown as ModelPort;
    const w = setup({ model });
    await w.post(variant('signal-thread-reply', 'Ev0SIGLLM001', { text: 'let me dig into the coupon service logs for this one' }));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ task: 'segmentation', schemaName: 'signal' });
    expect(requests[0]?.prompt).toContain('happens on every coupon');
    expect(w.web.conversationsReplies).toHaveBeenCalledWith(expect.objectContaining({ channel: CHANNEL, ts: ANCHOR, latest: '1730000090.000100', inclusive: false }));
    expect(w.outcomes).toMatchObject([{ kind: 'signal', intent: 'claim', source: 'message', outcome: { handled: true, effect: 'hold' } }]);
    expect((await comments()).at(-1)?.payload.confidence).toBe(0.9);

    // Outside an incident thread the model is never asked.
    await w.post(variant('signal-thread-reply', 'Ev0SIGLLM002', { text: 'let me dig into the coupon service logs', thread_ts: '1730000003.000100' }));
    expect(requests).toHaveLength(1);
    expect(w.outcomes.at(-1)).toEqual({ kind: 'ignored', reason: 'no-intent' });
  });

  it('the model pass takes a slot of the replier and the thread (#272); over a window or the day budget the reply gets the lexicon only', async () => {
    await filed();
    let requests = 0;
    const model = {
      classify: () => (requests++, Promise.resolve({ value: { intent: 'claim', confidence: 0.9 }, model: 'fake' })),
    } as unknown as ModelPort;
    const limits = createChatLimits({ budget: () => 1000, clock: () => NOW, windows: { perUser: { max: 1, windowMs: 60_000 } } });
    const w = setup({ model, limits });
    await w.post(variant('signal-thread-reply', 'Ev0SIGLIM001', { text: 'let me dig into the coupon service logs for this one' }));
    await w.post(variant('signal-thread-reply', 'Ev0SIGLIM002', { text: 'still digging through those coupon service logs' }));
    expect(requests).toBe(1);
    expect(w.outcomes.at(-1)).toEqual({ kind: 'ignored', reason: 'no-intent' });
    // The lexicon still reads a reply over the limit.
    await w.post(variant('signal-thread-reply', 'Ev0SIGLIM003', { text: 'on it' }));
    expect(w.outcomes.at(-1)).toMatchObject({ kind: 'signal', intent: 'claim' });
    const spent = createChatLimits({ budget: () => 0, clock: () => NOW });
    const v = setup({ model, limits: spent });
    await v.post(variant('signal-thread-reply', 'Ev0SIGLIM004', { user: PAT, text: 'let me dig into the coupon service logs for this one' }));
    expect(requests).toBe(1);
  });
});

// Five escalate reactions before the trigger, through the composed app ---------------------------

describe('five escalate reactions before the trigger, counted at creation (composed)', () => {
  const server = setupServer();
  const idleHarness: HarnessPort = { run: () => Promise.reject(new Error('the fake harness was not expected to run')) };
  let tdb: TestDatabase;
  let dir: string;

  const unhandled: string[] = [];
  beforeAll(() => {
    server.listen();
    server.events.on('request:unhandled', ({ request }) => {
      if (new URL(request.url).hostname !== '127.0.0.1') unhandled.push(`${request.method} ${request.url}`);
    });
  });
  afterAll(() => server.close());
  beforeEach(async () => {
    tdb = await createTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'snapwing-signals-'));
  });
  afterEach(async () => {
    server.resetHandlers();
    await tdb.drop();
    await rm(dir, { recursive: true, force: true });
  });

  it('stores them on the unreported message and adopts them when the bug reaction creates the incident', async () => {
    const recording = parseScenario('01-level-0-ticket-only.json', JSON.parse(await readFile(new URL('../../../../demo/levels/01-level-0-ticket-only.json', import.meta.url), 'utf8')));
    const channel = recording.channel.id;
    const anchor = recording.messages.find((m) => m.ts === recording.anchor);
    if (anchor === undefined) throw new Error('no anchor in the recording');
    slackWorld(server, channel, recording.messages.map((m) => ({ type: 'message', ...m })));
    const jiraWorld = new JiraWorld(() => undefined);
    const githubWorld = new GitHubWorld(() => undefined);
    githubWorld.addRepos(recording.github);
    server.use(
      ...jiraHandlers(jiraWorld),
      ...githubHandlers(githubWorld),
      http.post(`${GITHUB_API}/app/installations/:id/access_tokens`, () =>
        HttpResponse.json({ token: DEMO_GITHUB_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 }),
      ),
      http.get(`${SLACK_API}/reactions.get`, () =>
        HttpResponse.json({ ok: true, type: 'message', channel, message: { ...anchor, type: 'message', reactions: [{ name: 'bug', count: 1, users: [recording.reporter.id] }] } }),
      ),
    );
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const model = new RecordedModel();
    model.use(recording.name, recording.model);
    const booted = await bootComposed({
      state: await tdb.open(),
      configXml: await readFile(EXAMPLE_CONFIG, 'utf8'),
      secrets: { ...fakeSecrets(), JIRA_BASE_URL: JIRA_BASE, JIRA_EMAIL: DEMO_JIRA_EMAIL, JIRA_API_TOKEN: DEMO_JIRA_TOKEN, GITHUB_APP_PRIVATE_KEY: privateKey },
      dir,
      env: { SNAPWING_MAP: DEMO_MAP, SNAPWING_WORKDIR_ROOT: join(dir, 'work') },
      overrides: { model: withValidation(model), resolveHarness: () => idleHarness, slackBotUserId: BOT_USER, slackWorkspaceDomain: 'acme-test', projectorPollMs: 25 },
    });
    const { state } = booted;
    const event = async (id: string, e: Record<string, unknown>): Promise<void> => {
      const body = JSON.stringify({ type: 'event_callback', team_id: 'T0001', event_id: id, event_time: Number(recording.anchor), event: e });
      const res = await booted.api.fetch(new Request('http://snapwing.test/slack/events', { method: 'POST', headers: slackSigned(body), body }));
      expect(res.status).toBe(200);
    };
    const reaction = (user: string, name: string, at: number) => ({
      type: 'reaction_added',
      user,
      reaction: name,
      item_user: recording.reporter.id,
      item: { type: 'message', channel, ts: recording.anchor },
      event_ts: `${(Number(recording.anchor) + at).toFixed(0)}.000100`,
    });

    try {
      const reactors = ['U0FIRE1', 'U0FIRE2', 'U0FIRE3', 'U0FIRE4', 'U0FIRE5'];
      for (const [i, user] of reactors.entries()) await event(`Ev0FIRE${String(i)}`, reaction(user, 'fire', 10 + i));
      const cache = createKvCache(state);
      await vi.waitFor(
        async () => {
          for (let n = 0; n < reactors.length; n++) expect(await cache.get(pendingKey({ platform: 'slack', channel, messageId: recording.anchor }, n))).not.toBeNull();
        },
        { timeout: 10_000, interval: 25 },
      );
      expect(await state.findIncidents({ limit: 10 })).toEqual([]);

      // The bug reaction is the trigger: the incident is created, and `onCaptured` counts the five.
      await event('Ev0BUG01', reaction(recording.reporter.id, 'bug', 30));
      const incidentId = await vi.waitFor(
        async () => {
          const [incident] = await state.findIncidents({ limit: 10 });
          if (incident === undefined) throw new Error('no incident yet');
          const scores = await getEscalationScores(state.ctx, incident.id);
          expect(scores.find((s) => s.intent === 'escalate')).toMatchObject({ uniqueReactors: [...reactors].sort(), score: 5 });
          expect(scores.find((s) => s.intent === 'trigger')).toMatchObject({ uniqueReactors: [recording.reporter.id] });
          return incident.id;
        },
        { timeout: 20_000, interval: 50 },
      );
      const comments = (await state.read(incidentId)).filter((e): e is IncidentEvent<'comment'> => e.type === 'comment');
      expect(comments.filter((c) => c.payload.intent === 'escalate').map((c) => [c.actor?.id, c.payload.target?.role, c.payload.deepLink])).toEqual(
        reactors.map((r) => [r, 'anchor', `https://acme-test.slack.com/archives/${channel}/p${recording.anchor.replace('.', '')}`]),
      );
      expect(unhandled).toEqual([]);
    } finally {
      await booted.stop();
    }
  }, 60_000);
});
