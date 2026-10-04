// Teams signals (#392; A 1.1 to 1.4, A 1.6, A 3; main 15.1, 15.2): recorded Graph change notifications
// authenticated by the real `verifyNotification` (#379), Graph on MSW through the real client (#371), Bot
// Framework `messageReaction` activities, and the real signal handler over the dialect `SNAPWING_DB`
// selects. A trigger goes through the real adapter's normalizer (#383) behind a recording
// `handleInbound`; the engine, the Stop, and the fixer start are recording fakes.

import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultPlaybook } from '@snapwing/pipeline/config/playbook.ts';
import type { EventPayloads, EventType, IncidentEvent, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { CanonicalIncidentPayload } from '@snapwing/pipeline/contracts/incident.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { ClassifyRequest, ModelPort } from '@snapwing/pipeline/ports/model.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { createKvCache } from '@snapwing/pipeline/providers/local/cache.ts';
import type { SignalDeps } from '@snapwing/pipeline/signals/handler.ts';
import { recordBotMessage } from '@snapwing/pipeline/signals/messages.ts';
import type { TextSignalDeps } from '@snapwing/pipeline/signals/text.ts';
import type { StopInput } from '@snapwing/pipeline/fixer/stop.ts';
import type { StateStore } from '@snapwing/pipeline/state/store.ts';
import { createTestDatabase, TEST_DIALECT, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { createTeamsAdapter, type TeamsInbound } from '../../src/adapters/teams/adapter.ts';
import type { TeamsConnector } from '../../src/adapters/teams/connector.ts';
import { createTeamsGraph, type GraphMessage, type GraphReaction } from '../../src/adapters/teams/graph.ts';
import { teamsSnapshotOf } from '../../src/adapters/teams/normalize.ts';
import { emojiOfReactionType, TEAMS_REACTION_TABLE, teamsReactionName, teamsReactionNames } from '../../src/adapters/teams/reactions.ts';
import { createTeamsSignals, teamsReactionsKey, type TeamsSignalOutcome } from '../../src/adapters/teams/signals.ts';
import { createTeamsSubscriptions } from '../../src/adapters/teams/subscriptions.ts';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const CLIENT_STATE = 'teams-client-state-test';
const APP_ID = '00000000-0000-4000-8000-0000000000b0';
const WS = '01K6WORKSPACE0000000000000';
const INC = '01K6TEAMSSIGNALINC0000000A';
const TEAM = '2b9e4c7d-0000-4000-8000-0000000000a1';
const CHANNEL = '19:5f3c0a7e9d2b4c1a8e6f@thread.tacv2';
const ANCHOR = '1790000100123';
const REPLY = '1790000100777';
const STATUS_MSG = '1790000100900';
const UNREPORTED = '1790000200123';

const RAE = '6f1c2a3b-0000-4000-8000-00000000a001';
const SAM = '6f1c2a3b-0000-4000-8000-00000000e001';
const PAT = '6f1c2a3b-0000-4000-8000-00000000a002';

/** The trigger reaction that filed the incident, and when. */
const T_TRIGGER = Date.parse('2026-10-03T10:00:30.000Z');

const MAP: WorkspaceMap = {
  org: 'Example',
  updated: '2026-10-03T00:00:00Z',
  surfaces: [{ id: 'web', label: 'Website', repo: 'github.com/fake-org/web', jira: { project: 'WEB', defaultIssueType: 'Bug' }, components: [] }],
  channels: [{ id: CHANNEL, name: 'web-bugs', surface: 'web', platform: 'teams', teamId: TEAM, triggerEmoji: [] }],
  triggers: {
    messageActions: [{ label: 'Fix it from here' }],
    emoji: [
      { slack: 'bug', teams: 'bug' },
      { slack: 'fire', teams: 'fire', minReactors: 2 },
    ],
    directMessage: { images: true, text: true },
  },
  vocabulary: [],
  people: [
    { teamsId: RAE, handle: 'rae', email: 'rae@example.com', role: 'reporter', owns: [] },
    { teamsId: SAM, handle: 'sam', email: 'sam@example.com', role: 'engineer', owns: [] },
    { teamsId: PAT, handle: 'pat', role: 'reporter', owns: [] },
  ],
  policies: { autonomy: { default: 2, levels: [], overrides: [] } },
};

function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/teams/notifications/${name}.json`, import.meta.url), 'utf8')) as T;
}

/** A notification body for another message: the fixture with the message id swapped. */
function notificationFor(name: string, messageId: string): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fixture(name)).replaceAll(ANCHOR, messageId)) as Record<string, unknown>;
}

/** The reply notification for another reply in the anchor's thread. */
function replyCreated(replyId: string): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fixture('reply-created')).replaceAll(REPLY, replyId)) as Record<string, unknown>;
}

function reaction(user: string, reactionType: string, at: string): GraphReaction {
  return { reactionType, createdDateTime: at, user: { user: { id: user, userIdentityType: 'aadUser' } } };
}

// Graph on MSW: the messages the tests change, read by id --------------------------------------------

const messages = new Map<string, GraphMessage>();
const graphReads: string[] = [];
const server = setupServer(
  http.get(`${GRAPH}/teams/:team/channels/:channel/messages/:id/replies/:reply`, ({ params }) => {
    graphReads.push(`${String(params['id'])}/${String(params['reply'])}`);
    const m = messages.get(String(params['reply']));
    return m === undefined ? HttpResponse.json({ error: { code: 'NotFound', message: 'gone' } }, { status: 404 }) : HttpResponse.json(m);
  }),
  http.get(`${GRAPH}/teams/:team/channels/:channel/messages/:id/replies`, ({ params }) => {
    const root = String(params['id']);
    return HttpResponse.json({ value: [...messages.values()].filter((m) => m.replyToId === root) });
  }),
  http.get(`${GRAPH}/teams/:team/channels/:channel/messages/:id`, ({ params }) => {
    graphReads.push(String(params['id']));
    const m = messages.get(String(params['id']));
    return m === undefined ? HttpResponse.json({ error: { code: 'NotFound', message: 'gone' } }, { status: 404 }) : HttpResponse.json(m);
  }),
);
const unhandled: string[] = [];
beforeAll(() => {
  server.listen();
  server.events.on('request:unhandled', ({ request }) => {
    unhandled.push(`${request.method} ${request.url}`);
  });
});
afterEach(() => {
  server.resetHandlers();
  expect(unhandled.splice(0)).toEqual([]);
});
afterAll(() => server.close());

const subscriptions = createTeamsSubscriptions({
  graph: { createSubscription: () => Promise.reject(new Error('unused')), renewSubscription: () => Promise.reject(new Error('unused')) },
  cache: { get: () => Promise.resolve(null), set: () => Promise.resolve(), setIfAbsent: () => Promise.resolve(true) },
  notificationUrl: 'https://snapwing.test/teams/notifications',
  lifecycleUrl: 'https://snapwing.test/teams/lifecycle',
  clientState: CLIENT_STATE,
});

// The reaction table -------------------------------------------------------------------------------

describe('reactions.ts: Graph reactionType to the playbook teams names', () => {
  it('maps the legacy types, Unicode emoji, and the code point form to the A 1.1 names', () => {
    expect(['like', 'heart', 'laugh', 'surprised', 'sad', 'angry'].map(teamsReactionName)).toEqual(['like', 'heart', 'laugh', 'surprised', 'sad', 'angry']);
    expect(['🐛', '👀', '🔥', '🛑', '🔔', '👍', '🙏'].map(teamsReactionName)).toEqual(['bug', 'eyes', 'fire', 'stop', 'bell', 'like', 'pray']);
    expect(['🚨', '🙋', '🙅', '✋', '✅', '❤️', '🎉', '👎', '❌', '👁️', '🤷'].map(teamsReactionName)).toEqual([
      'rotating_light', 'raising_hand', 'no_good', 'raised_hand', 'white_check_mark', 'heart', 'tada', 'dislike', 'x', 'eye', 'shrug',
    ]);
    expect(['1f41b_bug', '1f440_eyes', '1f44d-1f3fd_thumbsup', '1f41e_ladybeetle'].map(teamsReactionName)).toEqual(['bug', 'eyes', 'like', 'ladybug']);
  });

  it('takes skin tones, variation selectors, and gendered forms back to the base emoji', () => {
    expect(['👍🏽', '🙋‍♀️', '🤷🏻‍♂️', '✋🏿', 'LIKE'].map(teamsReactionName)).toEqual(['like', 'raising_hand', 'shrug', 'raised_hand', 'like']);
    expect(emojiOfReactionType('❤️')).toBe('❤');
  });

  it('gives the names the default playbook uses where they differ from A 1.1 as aliases', () => {
    expect(teamsReactionNames('🛑')).toEqual(['stop', 'octagonal_sign']);
    expect(teamsReactionNames('like')).toEqual(['like', '+1']);
    expect(teamsReactionNames('👎')).toEqual(['dislike', '-1']);
  });

  it('ignores unknown types: never guessed', () => {
    expect(['custom', '🦄', 'thumbsup', '', '  ', 'zzzz_bug', '1f984_unicorn', 'like2'].map(teamsReactionName)).toEqual(Array(8).fill(undefined));
    expect(teamsReactionNames('🦄')).toEqual([]);
  });

  it('covers every default playbook emoji of every intent', () => {
    const names = new Set(TEAMS_REACTION_TABLE.flatMap((e) => [e.name, ...(e.aliases ?? [])]));
    const intents = defaultPlaybook().signals.intents;
    const missing = Object.values(intents).flatMap((i) => i.emoji.map((e) => e.teams)).filter((n) => !names.has(n));
    expect(missing).toEqual([]);
  });
});

// The signals module over a real store -------------------------------------------------------------

describe(`Teams signals (${TEST_DIALECT})`, () => {
  let tdb: TestDatabase;
  let state: OpenedState;
  let now = new Date('2026-10-03T10:05:00.000Z');

  beforeEach(async () => {
    messages.clear();
    graphReads.length = 0;
    now = new Date('2026-10-03T10:05:00.000Z');
    tdb = await createTestDatabase();
    state = await tdb.open({ now: () => now });
    for (const name of ['anchor-message', 'reply-on-it', 'status-card']) {
      const m = fixture<GraphMessage>(name);
      messages.set(m.id, m);
    }
  });

  afterEach(async () => {
    await tdb.drop();
  });

  function ev<T extends EventType>(type: T, payload: EventPayloads[T], at = T_TRIGGER): NewEvent<T> {
    return { workspaceId: WS, incidentId: INC, type, v: 1, source: 'agent', occurredAt: new Date(at).toISOString(), payload } as unknown as NewEvent<T>;
  }

  async function append(...events: NewEvent[]): Promise<void> {
    const last = (await state.read(INC)).at(-1)?.seq ?? 0;
    await state.append(INC, events, last);
  }

  /** A filed level 2 incident Rae's bug reaction opened on the anchor, with its status card recorded. */
  async function filed(): Promise<void> {
    await append(
      ev('captured', {
        kind: 'incident',
        idempotencyKey: `teams-${CHANNEL}-${ANCHOR}-bug`,
        source: 'teams',
        reporter: { id: RAE, name: 'rae', role: 'reporter' },
        anchorText: 'The coupon field rejects every code since this morning',
        anchorId: ANCHOR,
        channelId: CHANNEL,
        rawPayloadSnapshot: { type: 'reaction', channelId: CHANNEL, anchorId: ANCHOR, teamId: TEAM, reaction: 'bug', reactors: [RAE], files: [] },
      }),
      ev('context-assembled', { bundle: { artifactId: '01K6BUNDLE00000000000000001', version: 1 }, includedCount: 1, excludedCount: 0 }),
      ev('resolved', { surfaceId: 'web', componentId: 'checkout', repo: 'github.com/fake-org/web', resolvedBy: 'channel-explicit', confidence: 0.9 }),
      ev('dedupe-checked', { candidates: [], decision: 'none' }),
      ev('planned', { action: 'create_issue', projectKey: 'WEB', issueType: 'Bug', summary: 'Coupons rejected', priority: 'Medium', labels: ['snapwing'], autonomyLevel: 2 }),
      ev('filed', { jiraKey: 'WEB-1042' }),
    );
    await recordBotMessage(state, INC, { platform: 'teams', channel: CHANNEL, messageId: STATUS_MSG, role: 'status' }, () => new Date(T_TRIGGER));
  }

  function setReactions(messageId: string, reactions: GraphReaction[]): void {
    const m = messages.get(messageId);
    if (m === undefined) throw new Error(`no message ${messageId}`);
    messages.set(messageId, { ...m, reactions });
  }

  function setup(opts: { model?: ModelPort; text?: boolean } = {}) {
    const onError = vi.fn();
    const getMap = () => Promise.resolve(MAP);
    const cache = createKvCache(state as unknown as StateStore);
    const claims: { incidentId: string; seq: number }[] = [];
    const handlerStops: string[] = [];
    const stops: StopInput[] = [];
    const deps: SignalDeps = {
      workspaceId: WS,
      state,
      cache,
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
        handlerStops.push(input.incidentId);
        return Promise.resolve({ stopped: true } as never);
      },
      startFixer: () => Promise.resolve({ jobId: 'job-1' }),
      clock: () => now,
    };
    // The trigger path: the real adapter's normalizer behind a recording `handleInbound`.
    const adapter = createTeamsAdapter({
      connector: {} as TeamsConnector,
      appId: APP_ID,
      verify: () => Promise.resolve({ ok: false }),
      cache,
      getMap,
    });
    const inbound: TeamsInbound[] = [];
    const captured: CanonicalIncidentPayload[] = [];
    const handleInbound = async (source: 'teams', raw: TeamsInbound): Promise<void> => {
      expect(source).toBe('teams');
      inbound.push(raw);
      captured.push(await adapter.normalizePayload(raw));
    };
    const standingReplies: { aadObjectId: string; text: string }[] = [];
    const textPorts = {
      askResolution: vi.fn(() => Promise.resolve()),
      postScopeCard: vi.fn(() => Promise.resolve(undefined)),
      fileLinked: vi.fn(() => Promise.resolve(undefined)),
      assign: vi.fn(() => Promise.resolve()),
    };
    const text: TextSignalDeps = { workspaceId: WS, state, playbook: () => defaultPlaybook(), ports: textPorts, clock: () => now };
    const outcomes: TeamsSignalOutcome[][] = [];
    const signals = createTeamsSignals({
      deps,
      getMap,
      botAppId: APP_ID,
      graph: createTeamsGraph({ token: 'graph-test-token' }),
      handleInbound,
      stopIncident: (input) => {
        stops.push(input);
        return Promise.resolve({ stopped: true });
      },
      githubLinked: () => Promise.resolve(false),
      standing: state,
      confirmStanding: (c) => {
        standingReplies.push({ aadObjectId: c.aadObjectId, text: c.text });
        return Promise.resolve();
      },
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(opts.text === true ? { text } : {}),
      onOutcome: (o) => outcomes.push(o),
      onError,
    });
    /** A notification body through the real clientState check, then the signals module as the transport (#390) calls it. */
    const notify = async (body: Record<string, unknown>): Promise<TeamsSignalOutcome[]> => {
      const verified = subscriptions.verifyNotification(body);
      expect(verified).toHaveLength(1);
      await signals.onNotifications(verified);
      await signals.idle();
      return outcomes.at(-1) ?? [];
    };
    /** A `messageReaction` goes straight to `onActivity`; a `message` only when `observes` takes it. */
    const activity = async (body: Record<string, unknown>): Promise<TeamsSignalOutcome[]> => {
      if (body['type'] === 'message') expect(signals.observes(body)).toBe(true);
      await signals.onActivity(body);
      await signals.idle();
      return outcomes.at(-1) ?? [];
    };
    return { signals, notify, activity, onError, claims, stops, handlerStops, inbound, captured, cache, standingReplies, textPorts };
  }

  const comments = async (): Promise<IncidentEvent<'comment'>[]> => (await state.read(INC)).filter((e): e is IncidentEvent<'comment'> => e.type === 'comment');
  const updated = (): Record<string, unknown> => fixture('message-updated');

  it('add and remove, two people: each change of the reactions array is one signal per person, a redelivery none', async () => {
    await filed();
    const w = setup();

    // Sam's 👀 on the anchor: a claim, with the map role.
    setReactions(ANCHOR, [reaction(SAM, '👀', '2026-10-03T10:05:00.000Z')]);
    expect(await w.notify(updated())).toMatchObject([
      { kind: 'signal', intent: 'claim', source: 'reaction', outcome: { handled: true, role: 'anchor', effect: 'hold', appended: ['comment', 'claimed'] } },
    ]);
    expect((await state.read(INC)).at(-1)).toMatchObject({ type: 'claimed', actor: { id: SAM, role: 'engineer' } });
    expect(w.claims).toHaveLength(1);

    // Pat adds 🔥 (code point form); Sam's 👀 is unchanged and emits nothing. 🔥 is also a trigger
    // emoji that needs two people, so one is not a capture.
    now = new Date('2026-10-03T10:06:00.000Z');
    setReactions(ANCHOR, [reaction(SAM, '👀', '2026-10-03T10:05:00.000Z'), reaction(PAT, '1f525_fire', '2026-10-03T10:06:00.000Z')]);
    expect(await w.notify(updated())).toMatchObject([
      { kind: 'trigger', reaction: 'fire', reactor: PAT, captured: false },
      { kind: 'signal', intent: 'escalate', source: 'reaction', outcome: { handled: true, effect: 'count' } },
    ]);

    // The same notification again: the set already has both.
    expect(await w.notify(updated())).toEqual([{ kind: 'ignored', reason: 'no-change' }]);

    // The bot's own reaction, an app's, a custom one, and an unknown emoji change nothing.
    setReactions(ANCHOR, [
      reaction(SAM, '👀', '2026-10-03T10:05:00.000Z'),
      reaction(PAT, '1f525_fire', '2026-10-03T10:06:00.000Z'),
      reaction(APP_ID, '👍', '2026-10-03T10:06:10.000Z'),
      { reactionType: '👍', createdDateTime: '2026-10-03T10:06:10.000Z', user: { application: { id: 'other-app' } } },
      reaction(RAE, 'custom', '2026-10-03T10:06:20.000Z'),
      reaction(RAE, '🦄', '2026-10-03T10:06:30.000Z'),
    ]);
    expect(await w.notify(updated())).toEqual([{ kind: 'ignored', reason: 'no-change' }]);

    // Sam takes the 👀 back: a removal, which releases the claim (A 1.6).
    now = new Date('2026-10-03T10:07:00.000Z');
    setReactions(ANCHOR, [reaction(PAT, '1f525_fire', '2026-10-03T10:06:00.000Z')]);
    expect(await w.notify(updated())).toMatchObject([
      { kind: 'signal', intent: 'claim', source: 'reaction-removed', outcome: { handled: true, effect: 'release', appended: ['comment', 'released'] } },
    ]);

    const recorded = await comments();
    expect(recorded.map((c) => [c.actor?.id, c.payload.intent, c.payload.signalSource, c.payload.raw, c.payload.platform])).toEqual([
      [SAM, 'claim', 'reaction', 'eyes', 'teams'],
      [PAT, 'escalate', 'reaction', 'fire', 'teams'],
      [SAM, 'claim', 'reaction-removed', 'eyes', 'teams'],
    ]);
    expect(recorded[0]?.payload).toMatchObject({ target: { role: 'anchor', messageId: ANCHOR }, deepLink: messages.get(ANCHOR)?.webUrl });
    expect(recorded[1]?.occurredAt).toBe('2026-10-03T10:06:00.000Z');
    // The last set seen is kept for seven days.
    expect(JSON.parse((await w.cache.get(teamsReactionsKey(ANCHOR))) ?? '{}')).toMatchObject({ reactions: [{ user: PAT, name: 'fire' }] });
    expect(w.inbound).toEqual([]);
    expect(w.onError).not.toHaveBeenCalled();
  });

  it('the trigger with minReactors: the second person reaching it captures through the adapter; the bug captures alone', async () => {
    messages.set(UNREPORTED, { ...fixture<GraphMessage>('anchor-message'), id: UNREPORTED, webUrl: undefined as never });
    const w = setup();
    const body = notificationFor('message-updated', UNREPORTED);

    // One 🔥 of the two the map asks for: counted (pending, no incident yet), not captured.
    now = new Date('2026-10-03T10:10:00.000Z');
    setReactions(UNREPORTED, [reaction(PAT, '🔥', '2026-10-03T10:10:00.000Z')]);
    expect(await w.notify(body)).toMatchObject([
      { kind: 'trigger', reaction: 'fire', reactor: PAT, captured: false, reactors: [PAT] },
      { kind: 'signal', intent: 'escalate', outcome: { handled: false, reason: 'pending' } },
    ]);
    expect(w.inbound).toEqual([]);

    // Sam's 🔥 is the second: captured, Sam reporting, both reactors on the trigger.
    now = new Date('2026-10-03T10:10:20.000Z');
    setReactions(UNREPORTED, [reaction(PAT, '🔥', '2026-10-03T10:10:00.000Z'), reaction(SAM, '🔥', '2026-10-03T10:10:20.000Z')]);
    expect(await w.notify(body)).toMatchObject([
      { kind: 'trigger', reaction: 'fire', reactor: SAM, captured: true, reactors: [SAM, PAT] },
      { kind: 'signal', intent: 'escalate', outcome: { handled: false, reason: 'pending' } },
    ]);
    expect(w.inbound).toMatchObject([{ transport: 'graph', trigger: { teamId: TEAM, channelId: CHANNEL, reaction: 'fire', reactorAadId: SAM, reactors: [SAM, PAT], at: '2026-10-03T10:10:20.000Z' } }]);
    const fire = w.captured[0];
    expect(fire).toMatchObject({ idempotencyKey: `teams-${CHANNEL}-${UNREPORTED}-fire`, source: 'teams', reporter: { id: SAM, role: 'engineer' }, anchorAuthor: { id: RAE } });
    if (fire === undefined) throw new Error('not captured');
    expect(teamsSnapshotOf(fire)).toMatchObject({ type: 'reaction', anchorId: UNREPORTED, reaction: 'fire', reactors: [SAM, PAT] });

    // Rae's 🐛 needs nobody else.
    setReactions(UNREPORTED, [
      reaction(PAT, '🔥', '2026-10-03T10:10:00.000Z'),
      reaction(SAM, '🔥', '2026-10-03T10:10:20.000Z'),
      reaction(RAE, '1f41b_bug', '2026-10-03T10:10:40.000Z'),
    ]);
    expect(await w.notify(body)).toMatchObject([
      { kind: 'trigger', reaction: 'bug', reactor: RAE, captured: true, reactors: [RAE] },
      { kind: 'signal', intent: 'trigger', outcome: { handled: false, reason: 'pending' } },
    ]);
    expect(w.captured.map((p) => p.idempotencyKey)).toEqual([`teams-${CHANNEL}-${UNREPORTED}-fire`, `teams-${CHANNEL}-${UNREPORTED}-bug`]);

    // A trigger emoji on the bot's own card is never a capture.
    await filed();
    setReactions(STATUS_MSG, [reaction(PAT, '🐛', '2026-10-03T10:11:00.000Z')]);
    const onCard = await w.notify(notificationFor('message-updated', STATUS_MSG));
    expect(onCard.map((o) => o.kind)).toEqual(['signal']);
    expect(w.inbound).toHaveLength(2);
    expect(w.onError).not.toHaveBeenCalled();
  });

  it('a trigger removed within 60 s by its reactor is a Stop through the injected stopIncident', async () => {
    await filed();
    const w = setup();
    now = new Date(T_TRIGGER + 1_000);
    setReactions(ANCHOR, [reaction(RAE, '🐛', new Date(T_TRIGGER).toISOString())]);
    expect(await w.notify(updated())).toMatchObject([
      { kind: 'trigger', reaction: 'bug', captured: true },
      { kind: 'signal', intent: 'trigger', source: 'reaction', outcome: { handled: true, effect: 'count' } },
    ]);

    // Pat's 🐛 removed within the window: Pat did not trigger it, so no Stop.
    now = new Date(T_TRIGGER + 10_000);
    setReactions(ANCHOR, [reaction(RAE, '🐛', new Date(T_TRIGGER).toISOString()), reaction(PAT, '🐛', new Date(T_TRIGGER + 5_000).toISOString())]);
    await w.notify(updated());
    setReactions(ANCHOR, [reaction(RAE, '🐛', new Date(T_TRIGGER).toISOString())]);
    expect((await w.notify(updated())).map((o) => o.kind)).toEqual(['signal']);
    expect(w.stops).toEqual([]);

    // Rae takes hers back 45 s after the trigger.
    now = new Date(T_TRIGGER + 45_000);
    setReactions(ANCHOR, []);
    expect(await w.notify(updated())).toMatchObject([
      { kind: 'stopped', incidentId: INC, outcome: { stopped: true } },
      { kind: 'signal', intent: 'trigger', source: 'reaction-removed', outcome: { handled: true } },
    ]);
    expect(w.stops).toEqual([{ incidentId: INC, actor: { id: RAE, role: 'reporter', name: 'rae' }, source: 'teams', reason: 'trigger reaction removed' }]);
    // The handler never stops for it (`viaAdapter`).
    expect(w.handlerStops).toEqual([]);
  });

  it('a trigger removed after 60 s is no Stop; the removal is still recorded', async () => {
    await filed();
    const w = setup();
    now = new Date(T_TRIGGER + 1_000);
    setReactions(ANCHOR, [reaction(RAE, '🐛', new Date(T_TRIGGER).toISOString())]);
    await w.notify(updated());
    now = new Date(T_TRIGGER + 90_000);
    setReactions(ANCHOR, []);
    expect(await w.notify(updated())).toMatchObject([{ kind: 'signal', intent: 'trigger', source: 'reaction-removed', outcome: { handled: true } }]);
    expect(w.stops).toEqual([]);
    expect((await comments()).map((c) => c.payload.signalSource)).toEqual(['reaction', 'reaction-removed']);
  });

  it('a reply claim: "On it!" in the thread goes through the lexicon with the thread root as the target, and to the text signals', async () => {
    await filed();
    const w = setup({ text: true });
    now = new Date('2026-10-03T10:07:01.000Z');
    expect(await w.notify(fixture('reply-created'))).toMatchObject([
      {
        kind: 'signal',
        intent: 'claim',
        source: 'message',
        outcome: { handled: true, role: 'anchor', effect: 'hold' },
        text: { handled: false, reason: 'no-signal' },
      },
    ]);
    expect(graphReads).toContain(`${ANCHOR}/${REPLY}`);
    expect((await comments()).at(-1)).toMatchObject({
      actor: { id: SAM, role: 'engineer' },
      occurredAt: '2026-10-03T10:07:00.000Z',
      payload: { intent: 'claim', signalSource: 'message', raw: 'On it!', target: { role: 'anchor', messageId: ANCHOR }, deepLink: messages.get(REPLY)?.webUrl },
    });

    // Redelivered: handled once.
    expect(await w.notify(fixture('reply-created'))).toEqual([{ kind: 'ignored', reason: 'duplicate' }]);

    // A new root post is not a thread reply; a bot's reply and one that mentions the bot are not signals.
    const [root] = fixture<{ value: Record<string, unknown>[] }>('message-updated').value;
    expect(await w.notify({ value: [{ ...root, changeType: 'created' }] })).toEqual([{ kind: 'ignored', reason: 'not-a-thread-reply' }]);
    const reply = fixture<GraphMessage>('reply-on-it');
    messages.set('1790000100778', { ...reply, id: '1790000100778', from: { application: { id: APP_ID, displayName: 'Snapwing' } } });
    expect(await w.notify(replyCreated('1790000100778'))).toEqual([{ kind: 'ignored', reason: 'bot-message' }]);
    messages.set('1790000100779', {
      ...reply,
      id: '1790000100779',
      body: { contentType: 'html', content: '<p><at id="0">Snapwing</at> where are we?</p>' },
      mentions: [{ id: 0, mentionText: 'Snapwing', mentioned: { application: { id: APP_ID, displayName: 'Snapwing' } } }],
    });
    expect(await w.notify(replyCreated('1790000100779'))).toEqual([{ kind: 'ignored', reason: 'mentions-bot' }]);
    expect(w.onError).not.toHaveBeenCalled();
  });

  it('a reply delivered as a Bot Framework activity (RSC) is the same signal, and its Graph notification then counts nothing', async () => {
    await filed();
    const w = setup();
    const replied = fixture('reply-activity');

    // What the transport's `message` path asks: only a person's channel thread reply is ours.
    const { conversation: _c, channelData: _d, ...personal } = replied;
    expect(w.signals.observes({ ...personal, conversation: { id: 'a:1personal-chat-sam', conversationType: 'personal' } })).toBe(false);
    expect(w.signals.observes({ ...replied, conversation: { id: CHANNEL, conversationType: 'channel' }, replyToId: undefined })).toBe(false);
    expect(w.signals.observes({ ...replied, from: { id: `28:${APP_ID}`, name: 'Snapwing' } })).toBe(false);
    expect(w.signals.observes(fixture('message-reaction-activity'))).toBe(false);

    now = new Date('2026-10-03T10:07:01.000Z');
    expect(await w.activity(replied)).toMatchObject([
      { kind: 'signal', intent: 'claim', source: 'message', outcome: { handled: true, role: 'anchor', effect: 'hold' } },
    ]);
    expect((await comments()).at(-1)).toMatchObject({ actor: { id: SAM }, occurredAt: '2026-10-03T10:07:00.000Z', payload: { raw: 'On it!', target: { messageId: ANCHOR } } });
    expect(await w.notify(fixture('reply-created'))).toEqual([{ kind: 'ignored', reason: 'duplicate' }]);
    expect((await comments()).filter((c) => c.payload.signalSource === 'message')).toHaveLength(1);
  });

  it('a standing watch in the thread is a subscription, confirmed through confirmStanding; the model reads what the lexicon misses', async () => {
    await filed();
    const requests: ClassifyRequest<unknown>[] = [];
    const model = {
      classify: (req: ClassifyRequest<unknown>) => {
        requests.push(req);
        return Promise.resolve({ value: { intent: 'claim', confidence: 0.9 }, model: 'fake', usage: { inputTokens: 0, outputTokens: 0 } });
      },
    } as unknown as ModelPort;
    const w = setup({ model });
    const reply = fixture<GraphMessage>('reply-on-it');
    const post = async (id: string, from: string, content: string): Promise<TeamsSignalOutcome[]> => {
      messages.set(id, { ...reply, id, from: { user: { id: from, userIdentityType: 'aadUser' } }, body: { contentType: 'html', content } });
      return w.notify(replyCreated(id));
    };

    expect(await post('1790000100801', PAT, '<p>keep me posted on the website</p>')).toEqual([{ kind: 'standing', changed: true }]);
    expect(await state.getSubscriptions(INC)).toMatchObject([{ userId: PAT, scopeKind: 'surface', scopeId: 'web', channel: 'thread' }]);
    expect(w.standingReplies).toEqual([{ aadObjectId: PAT, text: 'Done. I will keep you posted on every incident on Website.' }]);
    expect(requests).toEqual([]);

    expect(await post('1790000100802', SAM, '<p>let me dig into the coupon service logs for this one</p>')).toMatchObject([
      { kind: 'signal', intent: 'claim', source: 'message', outcome: { handled: true, effect: 'hold' } },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ task: 'segmentation', schemaName: 'signal' });
    expect(requests[0]?.prompt).toContain('The coupon field rejects every code since this morning');
    expect((await comments()).at(-1)?.payload.confidence).toBe(0.9);
  });

  it('reduced mode (no notifications): reactions on the bot\'s own messages count through messageReaction, once', async () => {
    await filed();
    await createKvCache(state as unknown as StateStore).set(`teams-mode:${TEAM}`, 'reduced');
    const w = setup();
    now = new Date('2026-10-03T10:09:01.000Z');
    const liked = fixture('message-reaction-activity');

    // Sam's 👍 on the status card: an acknowledgement (A 1.3), from the activity alone.
    expect(await w.activity(liked)).toMatchObject([
      { kind: 'signal', intent: 'accept', source: 'reaction', outcome: { handled: true, role: 'status', effect: 'ack' } },
    ]);
    expect(graphReads).toEqual([]);
    expect((await comments()).at(-1)).toMatchObject({
      actor: { id: SAM },
      occurredAt: '2026-10-03T10:09:00.000Z',
      payload: { intent: 'accept', raw: 'like', target: { role: 'status', messageId: STATUS_MSG }, platform: 'teams' },
    });

    // Redelivered, or seen again by a Graph diff once notifications work: counted once.
    expect(await w.activity(liked)).toEqual([{ kind: 'ignored', reason: 'no-change' }]);
    expect(await w.notify(notificationFor('message-updated', STATUS_MSG))).toEqual([{ kind: 'ignored', reason: 'no-change' }]);

    // The bot's own reaction and an unknown one are ignored; the removal is a reaction-removed.
    expect(await w.activity({ ...liked, from: { id: `28:${APP_ID}`, name: 'Snapwing' } })).toEqual([{ kind: 'ignored', reason: 'own-reaction' }]);
    expect(await w.activity({ ...liked, reactionsAdded: [{ type: 'custom' }] })).toEqual([{ kind: 'ignored', reason: 'unknown-reaction' }]);
    const { reactionsAdded: _added, ...base } = liked;
    expect(await w.activity({ ...base, reactionsRemoved: [{ type: '👍' }] })).toMatchObject([{ kind: 'signal', intent: 'accept', source: 'reaction-removed' }]);
    expect((await comments()).map((c) => c.payload.signalSource)).toEqual(['reaction', 'reaction-removed']);
    expect(w.inbound).toEqual([]);
    expect(w.onError).not.toHaveBeenCalled();
  });
});
