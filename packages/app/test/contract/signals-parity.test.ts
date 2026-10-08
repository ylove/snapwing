// The A 8 parity row (#7): a recorded Slack `reaction_added` and a Teams Graph reaction diff for the
// same intent, actor, and target produce identical `SignalEvent`s (A 7) apart from `platform`.
//
// Each platform runs on its own fresh store holding the same incident (same id, same report time), one
// reported in Slack and one in Teams, through the real signal handler. The `SignalEvent` is read back
// from the `comment` event the handler recorded. "The same actor" is one person of the map, who has a
// Slack id and an AAD object id, and "the same target" is the incident's anchor, which has a Slack ts
// and a Graph message id: those two ids are each platform's own, so they are compared through the map
// (the person's handle) and the target role. Everything else must be equal as recorded, and so must
// what the handler did (its effect, the A 1.4 count, the events appended).

import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defaultPlaybook } from '@snapwing/pipeline/config/playbook.ts';
import type { IncidentEvent, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { ActorRole } from '@snapwing/pipeline/contracts/incident.ts';
import type { SignalEvent } from '@snapwing/pipeline/contracts/signals.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { createKvCache } from '@snapwing/pipeline/providers/local/cache.ts';
import type { SignalDeps, SignalOutcome } from '@snapwing/pipeline/signals/handler.ts';
import type { StateStore } from '@snapwing/pipeline/state/store.ts';
import { createTestDatabase, TEST_DIALECT, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { createSlackSignals } from '../../src/adapters/slack/signals.ts';
import { createTeamsGraph, type GraphMessage } from '../../src/adapters/teams/graph.ts';
import { createTeamsSignals } from '../../src/adapters/teams/signals.ts';
import { createTeamsSubscriptions } from '../../src/adapters/teams/subscriptions.ts';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const WS = '01K6WORKSPACE0000000000000';
const INC = '01K6PARITYINC0000000000000';

// Slack: the recorded fixtures' channel, anchor, and people.
const SLACK_CHANNEL = 'C0FAKEBUGS';
const SLACK_ANCHOR = '1730000000.000100';
const SLACK_PAT = 'U0FAKEPAT';
const SLACK_DANA = 'U0FAKEDANA';

// Teams: the same people by AAD object id, and the same report as a Graph channel message.
const CLIENT_STATE = 'teams-client-state-test';
const APP_ID = '00000000-0000-4000-8000-0000000000b0';
const TEAM = '2b9e4c7d-0000-4000-8000-0000000000a1';
const TEAMS_CHANNEL = '19:5f3c0a7e9d2b4c1a8e6f@thread.tacv2';
const TEAMS_ANCHOR = '1790000100123';
const TEAMS_PAT = '6f1c2a3b-0000-4000-8000-00000000a002';
const TEAMS_DANA = '6f1c2a3b-0000-4000-8000-00000000e002';

/** When both reports were made (the Slack anchor's ts). */
const REPORTED = 1_730_000_000_000;

const MAP: WorkspaceMap = {
  org: 'Example',
  updated: '2026-10-03T00:00:00Z',
  surfaces: [{ id: 'web', label: 'Website', repo: 'github.com/fake-org/web', jira: { project: 'WEB', defaultIssueType: 'Bug' }, components: [] }],
  channels: [
    { id: SLACK_CHANNEL, name: 'web-bugs', surface: 'web', triggerEmoji: [] },
    { id: TEAMS_CHANNEL, name: 'web-bugs-teams', surface: 'web', platform: 'teams', teamId: TEAM, triggerEmoji: [] },
  ],
  triggers: { messageActions: [{ label: 'Fix it from here' }], emoji: [{ slack: 'bug', teams: 'bug' }], directMessage: { images: true, text: true } },
  vocabulary: [],
  people: [
    { slackId: SLACK_PAT, teamsId: TEAMS_PAT, handle: 'pat', role: 'reporter', owns: [] },
    { slackId: SLACK_DANA, teamsId: TEAMS_DANA, handle: 'dana', role: 'engineer', owns: [] },
  ],
  policies: { autonomy: { default: 1, levels: [], overrides: [] } },
};

const slackFixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../fixtures/slack/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
const teamsFixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../fixtures/teams/notifications/${name}.json`, import.meta.url), 'utf8')) as T;

let anchor: GraphMessage = { ...teamsFixture<GraphMessage>('anchor-message'), reactions: [] };
const server = setupServer(http.get(`${GRAPH}/teams/:team/channels/:channel/messages/:id`, () => HttpResponse.json(anchor)));
const unhandled: string[] = [];
beforeAll(() => {
  server.listen();
  server.events.on('request:unhandled', ({ request }) => {
    unhandled.push(`${request.method} ${request.url}`);
  });
});
afterEach(() => {
  expect(unhandled.splice(0)).toEqual([]);
});
afterAll(() => server.close());

const subscriptions = createTeamsSubscriptions({
  graph: { createSubscription: () => Promise.reject(new Error('unused')), renewSubscription: () => Promise.reject(new Error('unused')) },
  cache: { get: () => Promise.resolve(null), set: () => Promise.resolve(), setIfAbsent: () => Promise.resolve(true), delete: () => Promise.resolve() },
  notificationUrl: 'https://snapwing.test/teams/notifications',
  lifecycleUrl: 'https://snapwing.test/teams/lifecycle',
  clientState: CLIENT_STATE,
});

/** One platform's store with the incident reported there. */
async function world(tdbs: TestDatabase[], platform: 'slack' | 'teams'): Promise<{ state: OpenedState; deps: SignalDeps }> {
  const tdb = await createTestDatabase();
  tdbs.push(tdb);
  const now = new Date(REPORTED + 120_000);
  const state = await tdb.open({ now: () => now });
  const captured = {
    workspaceId: WS,
    incidentId: INC,
    type: 'captured',
    v: 1,
    source: platform,
    occurredAt: new Date(REPORTED).toISOString(),
    payload: {
      kind: 'incident',
      idempotencyKey: platform === 'slack' ? `slack-${SLACK_CHANNEL}-${SLACK_ANCHOR}` : `teams-${TEAMS_CHANNEL}-${TEAMS_ANCHOR}`,
      source: platform,
      reporter: { id: platform === 'slack' ? SLACK_PAT : TEAMS_PAT, name: 'pat', role: 'reporter' },
      anchorText: 'The coupon field rejects every code',
      anchorId: platform === 'slack' ? SLACK_ANCHOR : TEAMS_ANCHOR,
      channelId: platform === 'slack' ? SLACK_CHANNEL : TEAMS_CHANNEL,
    },
  } as unknown as NewEvent;
  await state.append(INC, [captured], 0);
  const deps: SignalDeps = {
    workspaceId: WS,
    state,
    cache: createKvCache(state as unknown as StateStore),
    playbook: () => defaultPlaybook(),
    map: () => Promise.resolve(MAP),
    engine: { handleClaim: () => Promise.resolve({}), handleTap: () => Promise.resolve({ accepted: true, resumed: true }) },
    stopIncident: () => Promise.resolve({ stopped: true }),
    startFixer: () => Promise.resolve({}),
    clock: () => now,
  };
  return { state, deps };
}

/** A 7's `SignalEvent`, read back from the `comment` event the handler recorded. */
function signalEventOf(e: IncidentEvent<'comment'>): SignalEvent {
  const p = e.payload;
  if (p.target === undefined || e.actor === undefined) throw new Error('a chat signal has a target and an actor');
  return {
    incidentId: e.incidentId,
    intent: p.intent,
    confidence: p.confidence,
    source: p.signalSource,
    platform: p.platform,
    actor: { id: e.actor.id, name: p.actorName ?? '', role: e.actor.role as ActorRole },
    target: p.target,
    raw: p.raw,
    timestamp: e.occurredAt,
  };
}

/** The platform's own ids in map terms: the person's handle, and the anchor as the incident's anchor. */
function inMapTerms(event: SignalEvent): Omit<SignalEvent, 'platform'> {
  const { platform: _platform, ...rest } = event;
  const person = MAP.people.find((p) => p.slackId === event.actor.id || p.teamsId === event.actor.id);
  return {
    ...rest,
    actor: { ...event.actor, id: `person:${person?.handle ?? 'unmapped'}` },
    target: { role: event.target.role, messageId: event.target.messageId === SLACK_ANCHOR || event.target.messageId === TEAMS_ANCHOR ? 'anchor' : event.target.messageId },
  };
}

const lastComment = async (state: OpenedState): Promise<IncidentEvent<'comment'>> => {
  const comment = (await state.read(INC)).filter((e): e is IncidentEvent<'comment'> => e.type === 'comment').at(-1);
  if (comment === undefined) throw new Error('no comment recorded');
  return comment;
};

describe(`A 8 parity: Slack reaction_added and the Teams Graph diff (${TEST_DIALECT})`, () => {
  const tdbs: TestDatabase[] = [];
  afterEach(async () => {
    await Promise.all(tdbs.splice(0).map((t) => t.drop()));
  });

  async function slackSide(fixtureName: string): Promise<{ event: SignalEvent; outcome: SignalOutcome; comment: IncidentEvent<'comment'> }> {
    const { state, deps } = await world(tdbs, 'slack');
    const signals = createSlackSignals({ deps, getMap: () => Promise.resolve(MAP), botUserId: 'U0SNAPWING', workspaceDomain: 'example' });
    const outcome = await signals.handleEvent(slackFixture(fixtureName));
    if (outcome.kind !== 'signal') throw new Error(`slack: ${JSON.stringify(outcome)}`);
    const comment = await lastComment(state);
    return { event: signalEventOf(comment), outcome: outcome.outcome, comment };
  }

  async function teamsSide(reactor: string, reactionType: string, at: string): Promise<{ event: SignalEvent; outcome: SignalOutcome; comment: IncidentEvent<'comment'> }> {
    const { state, deps } = await world(tdbs, 'teams');
    anchor = { ...teamsFixture<GraphMessage>('anchor-message'), reactions: [{ reactionType, createdDateTime: at, user: { user: { id: reactor, userIdentityType: 'aadUser' } } }] };
    const signals = createTeamsSignals({ deps, getMap: () => Promise.resolve(MAP), botAppId: APP_ID, graph: createTeamsGraph({ token: 'graph-test-token' }) });
    const [notification] = subscriptions.verifyNotification(teamsFixture('message-updated'));
    if (notification === undefined) throw new Error('unverified');
    const outcomes = await signals.handleNotification(notification);
    const signal = outcomes.find((o) => o.kind === 'signal');
    if (signal?.kind !== 'signal') throw new Error(`teams: ${JSON.stringify(outcomes)}`);
    const comment = await lastComment(state);
    return { event: signalEventOf(comment), outcome: signal.outcome, comment };
  }

  it("escalate: Pat's 🔥 on the report (the recorded reaction_added) and the same 🔥 in Teams", async () => {
    const slack = await slackSide('signal-reaction-escalate');
    const teams = await teamsSide(TEAMS_PAT, '🔥', new Date(1_730_000_030_000).toISOString());

    expect(slack.event.platform).toBe('slack');
    expect(teams.event.platform).toBe('teams');
    expect(inMapTerms(teams.event)).toEqual(inMapTerms(slack.event));
    expect(inMapTerms(slack.event)).toEqual({
      incidentId: INC,
      intent: 'escalate',
      confidence: 1,
      source: 'reaction',
      actor: { id: 'person:pat', name: 'pat', role: 'reporter' },
      target: { role: 'anchor', messageId: 'anchor' },
      raw: 'fire',
      timestamp: '2024-10-27T03:33:50.000Z',
    });
    // What the handler did is the same too.
    expect(teams.outcome).toEqual(slack.outcome);
    expect(teams.comment.payload.count).toEqual(slack.comment.payload.count);
  });

  it("claim: Dana's 👀 on the report (the recorded reaction_added) and the same 👀 in Teams", async () => {
    const slack = await slackSide('signal-reaction-claim');
    const teams = await teamsSide(TEAMS_DANA, '1f440_eyes', new Date(1_730_000_060_000).toISOString());

    expect(inMapTerms(teams.event)).toEqual(inMapTerms(slack.event));
    expect(inMapTerms(slack.event)).toMatchObject({ intent: 'claim', actor: { id: 'person:dana', role: 'engineer' }, raw: 'eyes', target: { role: 'anchor' } });
    expect(teams.outcome).toEqual(slack.outcome);
    expect(slack.outcome).toMatchObject({ handled: true, effect: 'hold', appended: ['comment', 'claimed'] });
  });
});
