// Teams interactivity (#6; main 8.2, 11.2, 15.2, 16; A 2.1, A 2.2; B 5). `adaptiveCard/action` invokes
// as Teams sends them for taps on cards the card builders made and the remembering connector posted on
// MSW, over a real state store (SNAPWING_DB picks the dialect), the real `stopIncident` and
// `answerMidFlight`; the orchestrator and the PR actions are recording fakes.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { EventPayloads, EventType, IncidentEvent, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import { foldCursor, nextPhase, pendingCard } from '@snapwing/pipeline/engine/cursor.ts';
import type { TapInput, TapOutcome } from '@snapwing/pipeline/engine/orchestrator.ts';
import { answerMidFlight, type MidFlightDeps } from '@snapwing/pipeline/fixer/claims.ts';
import { stopIncident } from '@snapwing/pipeline/fixer/stop.ts';
import { PrActionRefusedError } from '@snapwing/pipeline/merge/actions.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { defaultPlaybook } from '@snapwing/pipeline/config/playbook.ts';
import { handleTextSignal, type LinkedIncidentRequest, type TextSignalDeps } from '@snapwing/pipeline/signals/text.ts';
import type { StateStore } from '@snapwing/pipeline/state/store.ts';
import { createKvCache } from '@snapwing/pipeline/providers/local/cache.ts';
import { InProcessWorkflow } from '@snapwing/pipeline/workflow/inprocess/index.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { JIRA_RESOLUTION_WONT_DO, NOT_PENDING_TEXT } from '../../src/adapters/shared/taps.ts';
import { cardActivity } from '../../src/adapters/teams/adapter.ts';
import { buildCard, type TeamsCardInput } from '../../src/adapters/teams/cards/cards.ts';
import type { AdaptiveCard, ExecuteAction, OpenUrlAction } from '../../src/adapters/teams/cards/elements.ts';
import { buildStatusCard, makeStatusUpdate } from '../../src/adapters/teams/cards/status.ts';
import { createTeamsConnector, type TeamsConnector } from '../../src/adapters/teams/connector.ts';
import {
  createKvTeamsCardStore,
  createTeamsInteractivity,
  LINK_GITHUB_LABEL,
  LINK_NOT_SENT_TEXT,
  LINK_SENT_TEXT,
  rememberTeamsCards,
  teamsCardKey,
  type PrActionInput,
  type TeamsCardStore,
  type TeamsInteractivity,
  type TeamsInteractivityOptions,
} from '../../src/adapters/teams/interactivity.ts';

const T0 = Date.parse('2026-10-03T09:00:00.000Z');
const WS = '01K6WORKSPACE0000000000000';
const INC = '01K6TEAMSTAP0000000000001';
const UNKNOWN_INC = '01K6TEAMSTAP0000000000999';
const APP_ID = '00000000-0000-4000-8000-0000000000b0';
const CHANNEL = '19:5f3c0a7e9d2b4c1a8e6f@thread.tacv2';
const ROOT = '1790000100123';
const THREAD = `${CHANNEL};messageid=${ROOT}`;
const SERVICE_URL = 'https://smba.test/amer/';
const TENANT = '7a0d5e6f-0000-4000-8000-0000000000c1';
const V3 = 'https://smba.test/amer/v3';
const RAE = '6f1c2a3b-0000-4000-8000-00000000a001'; // reporter
const SAM = '6f1c2a3b-0000-4000-8000-00000000e001'; // engineer, primary owner of web
const MO = '6f1c2a3b-0000-4000-8000-00000000e002'; // another engineer
const STRANGER = '6f1c2a3b-0000-4000-8000-00000000f001';
const RUN = 'run-1';
/** The head the PR card shows, and the merge commit the status card's Revert names (#264). */
const HEAD = 'a'.repeat(40);
const MERGE_COMMIT = 'c'.repeat(40);
/** A relink URL as `IdentityLinks.linkUrl` makes it: its single-use state has characters TextBlock escaping would mangle. */
const LINK_URL = 'https://snapwing.test/auth/github/start?state=k3_Fh-9xQ_v2';
/** The tapper's personal chat with the bot, as the Connector opens it. */
const PERSONAL = 'a:1personal-chat-0001';
const PERSONAL_PATH = `/amer/v3/conversations/${PERSONAL}/activities`;

const map: WorkspaceMap = {
  org: 'Example',
  updated: '2026-10-03T00:00:00Z',
  surfaces: [],
  channels: [{ id: CHANNEL, name: 'web-bugs', surface: 'web', platform: 'teams', teamId: '2b9e4c7d-0000-4000-8000-0000000000a1', triggerEmoji: [] }],
  triggers: { messageActions: [{ label: 'Fix it from here' }], emoji: [{ slack: 'bug', teams: 'bug' }], directMessage: { images: true, text: true } },
  vocabulary: [],
  people: [
    { teamsId: RAE, handle: 'rae', role: 'reporter', owns: [] },
    { teamsId: SAM, handle: 'sam', role: 'engineer', owns: [{ surface: 'web', primary: true }] },
    { teamsId: MO, handle: 'mo', role: 'engineer', owns: [] },
    // A Slack-only engineer is never the Teams approver.
    { slackId: 'U0WEBDEV1', handle: 'webDev1', role: 'engineer', owns: [{ surface: 'web', component: 'nav', primary: true }] },
  ],
  policies: { autonomy: { default: 1, levels: [], overrides: [] } },
};

// Bot Connector on MSW ------------------------------------------------------------------------------

interface Seen {
  method: string;
  path: string;
  body: Record<string, unknown>;
}
let seen: Seen[] = [];
let nextId = 0;

async function capture(request: Request): Promise<Record<string, unknown>> {
  const body = (await request.json()) as Record<string, unknown>;
  seen.push({ method: request.method, path: decodeURIComponent(new URL(request.url).pathname), body });
  return body;
}

const server = setupServer(
  // createPersonalConversation: the tapper's personal chat with the bot.
  http.post(`${V3}/conversations`, async ({ request }) => {
    await capture(request);
    return HttpResponse.json({ id: PERSONAL });
  }),
  http.post(`${V3}/conversations/:conversation/activities`, async ({ request }) => {
    await capture(request);
    return HttpResponse.json({ id: `17900009000${String(++nextId).padStart(2, '0')}` });
  }),
  http.post(`${V3}/conversations/:conversation/activities/:activityId`, async ({ request }) => {
    await capture(request);
    return HttpResponse.json({ id: `17900009000${String(++nextId).padStart(2, '0')}` });
  }),
  http.put(`${V3}/conversations/:conversation/activities/:activityId`, async ({ request, params }) => {
    await capture(request);
    return HttpResponse.json({ id: String(params['activityId']) });
  }),
);
beforeAll(() => server.listen());
afterAll(() => server.close());

// World -----------------------------------------------------------------------------------------------

/** The store's kv as the cache port (openState returns a StateStore). */
const kvOf = (s: OpenedState) => createKvCache(s as unknown as StateStore);

let tdb: TestDatabase;
let state: OpenedState;
let now: number;
let taps: TapInput[];
let tapOutcome: TapOutcome;
/** The fake orchestrator also refuses a card the incident is not waiting on, as the real one does. */
let checkPending: boolean;
let cancelled: string[];
let assigned: string[];
let prCalls: { action: string; input: PrActionInput }[];
let prBehavior: (action: string) => Promise<void>;
let linked: Set<string>;
let store: TeamsCardStore;
let connector: TeamsConnector;
let ix: TeamsInteractivity;
let outcomes: unknown[];
let errors: unknown[];

function make(extra: Partial<TeamsInteractivityOptions> = {}): TeamsInteractivity {
  const deps: MidFlightDeps = {
    workspaceId: WS,
    state,
    workflow: new InProcessWorkflow(state),
    runner: { runFixer: () => Promise.reject(new Error('not in this test')), cancel: (id) => (cancelled.push(id), Promise.resolve()) },
    github: { markIncomplete: () => Promise.resolve(), closePr: () => Promise.resolve() },
    config: { harness: { adapter: 'claude-code' } },
    clock: () => new Date(now),
    ports: {
      postCard: () => Promise.resolve(),
      notify: () => Promise.resolve(),
      assign: (_incident, claimer) => (assigned.push(claimer), Promise.resolve()),
    },
  };
  const record = (action: string) => async (input: PrActionInput) => {
    prCalls.push({ action, input });
    await prBehavior(action);
  };
  return createTeamsInteractivity({
    connector,
    cache: kvOf(state),
    cardStore: store,
    state,
    workspaceId: WS,
    orchestrator: {
      // The real orchestrator refuses a tap on an incident it has no log for.
      handleTap: async (tap) => {
        if ((await state.getIncident(tap.eventId)) === null) return { accepted: false, reason: 'not-pending' };
        if (checkPending && pendingCard(nextPhase(foldCursor(tap.eventId, await state.read(tap.eventId)), { scopePreview: false })) !== tap.card) {
          return { accepted: false, reason: 'not-pending' };
        }
        taps.push(tap);
        return tapOutcome;
      },
    },
    stopIncident: (input) => stopIncident(deps, input),
    prActions: { merge: record('merge'), requestChanges: record('request_changes'), revert: record('revert') },
    midFlight: (input) => answerMidFlight(deps, input),
    getMap: () => Promise.resolve(map),
    githubLinked: (aad) => linked.has(aad),
    clock: () => new Date(now),
    onOutcome: (o) => outcomes.push(o),
    onError: (e) => errors.push(e),
    ...extra,
  });
}

beforeEach(async () => {
  tdb = await createTestDatabase();
  now = T0;
  state = await tdb.open({ now: () => new Date(now) });
  seen = [];
  nextId = 0;
  taps = [];
  tapOutcome = { accepted: true, resumed: true };
  checkPending = false;
  cancelled = [];
  assigned = [];
  prCalls = [];
  prBehavior = () => Promise.resolve();
  linked = new Set();
  outcomes = [];
  errors = [];
  store = createKvTeamsCardStore(kvOf(state));
  connector = rememberTeamsCards(createTeamsConnector({ token: () => Promise.resolve('teams-test-token'), botId: APP_ID }), store);
  ix = make();
});

afterEach(async () => {
  server.resetHandlers();
  await tdb.drop();
});

// Log ---------------------------------------------------------------------------------------------

function ev<T extends EventType>(type: T, payload: EventPayloads[T], actor?: { id: string; role: 'engineer' | 'reporter' }): NewEvent<T> {
  return {
    workspaceId: WS,
    incidentId: INC,
    type,
    v: 1,
    source: 'agent',
    occurredAt: new Date(now).toISOString(),
    payload,
    ...(actor === undefined ? {} : { actor }),
  } as unknown as NewEvent<T>;
}

async function append(events: NewEvent[]): Promise<void> {
  const last = (await state.read(INC)).at(-1)?.seq ?? 0;
  await state.append(INC, events, last);
}

/** Captured from Rae's action command on web, planned at `level`. */
async function seedPlanned(level: 0 | 1 | 2 | 3): Promise<void> {
  await append([
    ev('captured', {
      kind: 'incident',
      idempotencyKey: `teams-${CHANNEL}-${ROOT}-action`,
      source: 'teams',
      reporter: { id: RAE, name: 'Rae Reporter', role: 'reporter' },
      anchorText: 'the total shows NaN after a promo code',
      anchorId: ROOT,
      channelId: CHANNEL,
      rawPayloadSnapshot: { type: 'action-command' },
    }),
    ev('context-assembled', { bundle: { artifactId: '01K6BUNDLE00000000000000001', version: 1 }, includedCount: 2, excludedCount: 0 }),
    ev('resolved', { surfaceId: 'web', componentId: 'cart', repo: 'github.com/acme/web', resolvedBy: 'channel-explicit', confidence: 0.9 }),
    ev('dedupe-checked', { candidates: [], decision: 'none' }),
    ev('planned', {
      action: 'create_issue',
      projectKey: 'WEB',
      issueType: 'Bug',
      summary: 'Cart total is NaN after a promo code',
      priority: 'High',
      labels: ['snapwing'],
      autonomyLevel: level,
      implementationRequest: { artifactId: '01K6REQUEST000000000000001', version: 1 },
    }),
  ]);
}

async function seedFixing(level: 1 | 2 | 3): Promise<void> {
  await seedPlanned(level);
  await append([ev('filed', { jiraKey: 'WEB-1042' }), ev('fixer-started', { runId: RUN, harness: 'claude-code', attempt: 1 })]);
}

async function seedPrOpen(level: 1 | 2 | 3): Promise<void> {
  await seedFixing(level);
  await append([
    ev('fixer-done', { prNumber: 77, branch: 'fix/WEB-1042', summary: 'Recompute the total', testsAdded: [] }),
    ev('pr-opened', { prNumber: 77, branch: 'fix/WEB-1042' }),
  ]);
}

/** Filed at `level` and claimed by Sam before any fixer: the claim card waits (A 2.1). */
async function seedClaimed(level: 1 | 2 = 1): Promise<void> {
  await seedPlanned(level);
  await append([
    ev('filed', { jiraKey: 'WEB-1042' }),
    ev('waiting-changed', {}),
    ev('claimed', { claimerId: SAM, expiresAt: new Date(T0 + 4 * 3_600_000).toISOString() }, { id: SAM, role: 'engineer' }),
    ev('waiting-changed', { waitingOn: { kind: 'human', who: SAM } }),
  ]);
}

async function types(): Promise<EventType[]> {
  return (await state.read(INC)).map((e) => e.type);
}

async function lastOf<T extends EventType>(type: T): Promise<IncidentEvent<T> | undefined> {
  return (await state.read(INC)).filter((e) => e.type === type).at(-1) as IncidentEvent<T> | undefined;
}

// Cards and invokes ---------------------------------------------------------------------------------

const PEOPLE: Readonly<Record<string, string>> = { [RAE]: 'Rae Reporter', [SAM]: 'Sam Engineer', [MO]: 'Mo Engineer', [STRANGER]: 'Stranger Danger' };

const scope: TeamsCardInput = { kind: 'scope-preview', summary: 'Reading 4 messages from the thread.' };
const dedupe: TeamsCardInput = { kind: 'dedupe', issueKey: 'WEB-9', summary: 'Cart total wrong' };
const clarify: TeamsCardInput = {
  kind: 'clarify',
  question: { audience: 'reporter', text: 'Which page?', options: ['Cart', 'Checkout'], asks: 'surface', gatePassed: true, gateFailures: [] },
};
function fixPreview(level: 1 | 2 | 3): TeamsCardInput {
  return {
    kind: 'fix-preview',
    ownerUserId: SAM,
    plan: {
      action: 'create_issue',
      projectKey: 'WEB',
      issueType: 'Bug',
      summary: 'Cart total is NaN after a promo code',
      descriptionAdf: { type: 'doc', version: 1, content: [] },
      priority: 'High',
      labels: ['snapwing'],
      autonomyLevel: level,
    },
  };
}
const claimed: TeamsCardInput = { kind: 'claimed', issueKey: 'WEB-1042', claimerUserId: SAM };
const prReady: TeamsCardInput = {
  kind: 'pr-ready',
  prNumber: 77,
  headSha: HEAD,
  prUrl: 'https://github.com/acme/web/pull/77',
  issueKey: 'WEB-1042',
  reviewVerdict: 'approve',
  ciState: 'green',
  filesChanged: 1,
  additions: 3,
  deletions: 1,
  reviewerUserIds: [SAM],
};
const midFlight: TeamsCardInput = {
  kind: 'mid-flight',
  issueKey: 'WEB-1042',
  claimerUserId: SAM,
  runId: RUN,
  runAgeMs: 240_000,
  branch: 'fix/WEB-1042',
  choices: ['let-it-finish', 'stop-it'],
  grace: 'PT10M',
};

function build(input: TeamsCardInput, incidentId = INC): AdaptiveCard {
  return buildCard(incidentId, input, { canMerge: true });
}

/** Posts `card` in the incident's thread through the remembering connector; the card's activity id. */
async function post(card: AdaptiveCard): Promise<string> {
  const out = await connector.replyToActivity({ serviceUrl: SERVICE_URL, conversationId: CHANNEL, activityId: ROOT, threadRootId: ROOT }, cardActivity(card));
  seen = [];
  return out.id;
}

function executeAction(card: AdaptiveCard, verb: string): ExecuteAction {
  const action = card.actions?.find((a): a is ExecuteAction => a.type === 'Action.Execute' && a.verb === verb);
  if (action === undefined) throw new Error(`no ${verb} on the card`);
  return action;
}

/** An `adaptiveCard/action` invoke as Teams sends it for a tap by `user` on the card in `replyToId`. */
function invoke(user: string, action: Pick<ExecuteAction, 'verb' | 'data'> & { title?: string }, replyToId: string | undefined): Record<string, unknown> {
  return {
    name: 'adaptiveCard/action',
    type: 'invoke',
    timestamp: new Date(now).toISOString(),
    id: 'f:invoke-0001',
    channelId: 'msteams',
    serviceUrl: SERVICE_URL,
    from: { id: `29:${user}`, name: PEOPLE[user] ?? 'Someone', aadObjectId: user },
    conversation: { isGroup: true, conversationType: 'channel', tenantId: TENANT, id: THREAD },
    recipient: { id: `28:${APP_ID}`, name: 'Snapwing' },
    ...(replyToId === undefined ? {} : { replyToId }),
    channelData: { channel: { id: CHANNEL }, tenant: { id: TENANT }, source: { name: 'message' } },
    value: { action: { type: 'Action.Execute', ...(action.title === undefined ? {} : { title: action.title }), verb: action.verb, data: action.data }, trigger: 'manual' },
  };
}

/** Posts the card, then taps `verb` on it as `user`. */
async function tapOn(user: string, input: TeamsCardInput, verb: string) {
  const card = build(input);
  const id = await post(card);
  const result = await ix.handleInvoke(invoke(user, executeAction(card, verb), id));
  return { card, id, outcome: result.outcome, response: result.card };
}

/** The card the invoke is answered with (the transport, puts it in the Universal Actions response). */
function answeredCard(answer: AdaptiveCard | undefined): AdaptiveCard {
  if (answer === undefined) throw new Error('answered with no card');
  return answer;
}

const lastLine = (c: AdaptiveCard): string | undefined => c.body.at(-1)?.text;
const mentioned = (c: AdaptiveCard): string[] => (c.msteams?.entities ?? []).map((e) => e.mentioned.id);
const cardIn = (s: Seen | undefined): AdaptiveCard | undefined => (s?.body['attachments'] as { content: AdaptiveCard }[] | undefined)?.[0]?.content;
/** The path of the card message `id` in the incident's thread. */
const cardPath = (id: string): string => `/amer/v3/conversations/${THREAD}/activities/${id}`;

/** The edits in place (`updateActivity`) the Connector saw, as the cards they put up. */
function edits(): { path: string; card: AdaptiveCard | undefined }[] {
  return seen.filter((s) => s.method === 'PUT').map((s) => ({ path: s.path, card: cardIn(s) }));
}

/** `url` reached `user` in their personal chat as an `Action.OpenUrl` button, and no other request carried it. */
function expectLinkSentPrivately(user: string, url: string): void {
  const opened = seen.filter((s) => s.path === '/amer/v3/conversations');
  expect(opened).toHaveLength(1);
  expect(opened[0]?.body).toMatchObject({ isGroup: false, members: [{ id: `29:${user}`, aadObjectId: user }], tenantId: TENANT });
  const sent = seen.filter((s) => s.path === PERSONAL_PATH);
  expect(sent).toHaveLength(1);
  const prompt = cardIn(sent[0]);
  expect(prompt?.actions).toEqual([{ type: 'Action.OpenUrl', title: LINK_GITHUB_LABEL, url } satisfies OpenUrlAction]);
  expect(JSON.stringify(prompt?.body)).not.toContain(url);
  expect(seen.filter((s) => s.path !== PERSONAL_PATH && JSON.stringify(s.body).includes(url))).toEqual([]);
}

// Card choices ------------------------------------------------------------------------------------

describe('card choices go to handleTap with the tapper resolved by AAD object id', () => {
  const cases: { input: TeamsCardInput; card: string; verb: string; label: string }[] = [
    { input: scope, card: 'scope-preview', verb: 'looks-right', label: 'Looks right' },
    { input: scope, card: 'scope-preview', verb: 'widen', label: 'Widen' },
    { input: scope, card: 'scope-preview', verb: 'narrow', label: 'Narrow' },
    { input: dedupe, card: 'dedupe', verb: 'link', label: 'Link this thread to WEB-9' },
    { input: dedupe, card: 'dedupe', verb: 'create-anyway', label: 'Create new anyway' },
    { input: dedupe, card: 'dedupe', verb: 'not-related', label: 'Not related' },
    { input: clarify, card: 'clarify', verb: 'Checkout', label: 'Checkout' },
    { input: fixPreview(1), card: 'fix-preview', verb: 'ticket_only', label: 'Ticket only' },
    { input: fixPreview(1), card: 'fix-preview', verb: 'dismiss', label: 'Not a bug' },
  ];

  for (const c of cases) {
    it(`${c.card}: ${c.verb}`, async () => {
      await seedPlanned(1);
      const { outcome, response, card, id } = await tapOn(RAE, c.input, c.verb);
      expect(outcome).toEqual({ kind: 'tapped', card: c.card, choice: c.verb, outcome: { accepted: true, resumed: true } });
      expect(taps).toEqual([{ eventId: INC, card: c.card, choice: c.verb, actor: { id: RAE, role: 'reporter' } }]);
      // The answer is the card refreshed: its body, then who chose what in place of the buttons.
      const refreshed = answeredCard(response);
      expect(refreshed.actions).toBeUndefined();
      expect(refreshed.body.slice(0, card.body.length)).toEqual(card.body);
      expect(lastLine(refreshed)).toBe(`<at>rae</at> chose ${c.label}.`);
      expect(mentioned(refreshed)).toContain(RAE);
      // The answer updates only the tapper's view, so the message is also edited in place for everyone,
      // and remembered as answered. Nothing is posted (Teams has no ephemeral).
      expect(await store.get(THREAD, id)).toEqual(refreshed);
      expect(edits()).toEqual([{ path: cardPath(id), card: refreshed }]);
      expect(seen.filter((s) => s.method !== 'PUT')).toEqual([]);
    });
  }

  it('an engineer taps Fix it at level 1', async () => {
    await seedPlanned(1);
    const { outcome } = await tapOn(SAM, fixPreview(1), 'approve_fix');
    expect(outcome).toMatchObject({ kind: 'tapped', card: 'fix-preview', choice: 'approve_fix' });
    expect(taps).toEqual([{ eventId: INC, card: 'fix-preview', choice: 'approve_fix', actor: { id: SAM, role: 'engineer' } }]);
  });

  it('the claim card: Let the agent take it, and Not a bug while the claim card waits', async () => {
    await seedClaimed();
    expect((await tapOn(SAM, claimed, 'let-agent-take')).outcome).toMatchObject({ kind: 'tapped', card: 'claimed', choice: 'let-agent-take' });
    expect((await tapOn(MO, claimed, 'dismiss')).outcome).toMatchObject({ kind: 'tapped', card: 'claimed', choice: 'dismiss' });
    expect(taps.map((t) => [t.card, t.choice, t.actor.id])).toEqual([
      ['claimed', 'let-agent-take', SAM],
      ['claimed', 'dismiss', MO],
    ]);
  });

  it('a person outside the map is an unknown role, named from the activity', async () => {
    await seedPlanned(1);
    const { response } = await tapOn(STRANGER, scope, 'looks-right');
    expect(taps[0]?.actor).toEqual({ id: STRANGER, role: 'unknown' });
    expect(lastLine(answeredCard(response))).toBe('<at>Stranger Danger</at> chose Looks right.');
  });

  it('a tap on a card that is no longer waiting answers with the same card and the reason; the buttons stay', async () => {
    await seedPlanned(1);
    tapOutcome = { accepted: false, reason: 'not-pending' };
    const { outcome, response, card, id } = await tapOn(RAE, dedupe, 'create-anyway');
    expect(outcome).toMatchObject({ kind: 'tapped', outcome: { accepted: false, reason: 'not-pending' } });
    const answered = answeredCard(response);
    expect(answered.actions).toEqual(card.actions);
    expect(answered.body).toEqual([...card.body, expect.objectContaining({ text: 'This card already has an answer.' })]);
    // The remembered card is still the original, so a second refusal shows one reason, not two.
    expect(await store.get(THREAD, id)).toEqual(card);
    // The reason is the tapper's alone: the shared message is not edited.
    expect(seen).toEqual([]);
  });

  it('without a remembered card: an accepted tap answers with the line alone, a refused one leaves the card', async () => {
    await seedPlanned(1);
    const card = build(scope);
    const accepted = await ix.handleInvoke(invoke(RAE, { ...executeAction(card, 'looks-right'), title: 'Looks right' }, undefined));
    expect(answeredCard(accepted.card).body.map((b) => b.text)).toEqual(['<at>rae</at> chose Looks right.']);
    tapOutcome = { accepted: false, reason: 'not-pending' };
    const refused = await ix.handleInvoke(invoke(RAE, executeAction(card, 'widen'), '1790000999999'));
    expect(refused).toEqual({ outcome: expect.objectContaining({ kind: 'tapped', outcome: { accepted: false, reason: 'not-pending' } }) });
    // With no card body to keep, the shared message is left as it is.
    expect(seen).toEqual([]);
  });

  it("a clarify option that reads like a reserved verb is a clarify answer, never that verb's path", async () => {
    await seedPrOpen(2);
    linked.add(RAE);
    const reserved: TeamsCardInput = {
      kind: 'clarify',
      question: { audience: 'reporter', text: 'Which button did you press?', options: ['stop', 'merge'], asks: 'surface', gatePassed: true, gateFailures: [] },
    };
    const { outcome, card } = await tapOn(RAE, reserved, 'stop');
    // The card says what it is in the data its buttons carry.
    expect(executeAction(card, 'stop').data).toEqual({ incidentId: INC, card: 'clarify' });
    expect(outcome).toEqual({ kind: 'tapped', card: 'clarify', choice: 'stop', outcome: { accepted: true, resumed: true } });
    expect(taps.map((t) => [t.card, t.choice])).toEqual([['clarify', 'stop']]);
    // With no remembered card too: `merge` stays a clarify answer and never reaches the PR actions.
    const merged = await ix.handleInvoke(invoke(RAE, executeAction(card, 'merge'), undefined));
    expect(merged.outcome).toEqual({ kind: 'tapped', card: 'clarify', choice: 'merge', outcome: { accepted: true, resumed: true } });
    expect(prCalls).toEqual([]);
    expect(cancelled).toEqual([]);
    expect(await types()).not.toContain('stopped');
  });
});

// Not a bug, by the card tapped -------------------------------------------------------------------

describe('Not a bug goes by the card tapped, not by what the incident waits on', () => {
  /** Sam's `Let the agent take it` recorded, and the fixer it starts. */
  const agentTookIt = (): Promise<void> =>
    append([
      ev('tapped', { eventId: INC, card: 'claimed', choice: 'let-agent-take' }, { id: SAM, role: 'engineer' }),
      ev('fixer-started', { runId: RUN, harness: 'claude-code', attempt: 1 }),
    ]);

  async function expectNothingStopped(): Promise<void> {
    expect(await types()).not.toContain('stopped');
    expect(await types()).not.toContain('not-a-bug');
    expect(cancelled).toEqual([]);
    expect((await state.drainOutbox('jira', 100)).filter((r) => r.op === 'transition')).toEqual([]);
  }

  it("level 2: Rae's Not a bug on the claim card Sam answered is told the card has an answer, and Sam's fixer keeps going", async () => {
    await seedClaimed(2);
    const card = build(claimed);
    const id = await post(card);
    const bySam = await ix.handleInvoke(invoke(SAM, executeAction(card, 'let-agent-take'), id));
    expect(bySam.outcome).toMatchObject({ kind: 'tapped', card: 'claimed', choice: 'let-agent-take' });
    await agentTookIt();
    seen = [];
    // Rae still sees the buttons and taps Not a bug on the same card.
    const byRae = await ix.handleInvoke(invoke(RAE, executeAction(card, 'dismiss'), id));
    expect(byRae.outcome).toEqual({ kind: 'ignored', reason: 'card-answered' });
    expect(lastLine(answeredCard(byRae.card))).toBe(NOT_PENDING_TEXT);
    await expectNothingStopped();
    expect(taps.map((t) => [t.card, t.choice, t.actor.id])).toEqual([['claimed', 'let-agent-take', SAM]]);
    // Told to Rae alone: the shared message keeps Sam's answer.
    expect(seen).toEqual([]);
  });

  it('level 2: the same tap while the remembered claim card still has its buttons is the claim card, no longer waiting', async () => {
    checkPending = true;
    await seedClaimed(2);
    const card = build(claimed);
    const id = await post(card);
    // Sam's answer reached the incident without refreshing this card.
    await agentTookIt();
    const { outcome, card: response } = await ix.handleInvoke(invoke(RAE, executeAction(card, 'dismiss'), id));
    expect(outcome).toEqual({ kind: 'tapped', card: 'claimed', choice: 'dismiss', outcome: { accepted: false, reason: 'not-pending' } });
    expect(lastLine(answeredCard(response))).toBe(NOT_PENDING_TEXT);
    await expectNothingStopped();
    expect(seen).toEqual([]);
  });

  it("a stale fix preview's Not a bug does not answer the claim card that waits", async () => {
    checkPending = true;
    await seedClaimed();
    const preview = build(fixPreview(1));
    const previewId = await post(preview);
    const claim = build(claimed);
    const claimId = await post(claim);
    const stale = await ix.handleInvoke(invoke(RAE, executeAction(preview, 'dismiss'), previewId));
    expect(stale.outcome).toEqual({ kind: 'tapped', card: 'fix-preview', choice: 'dismiss', outcome: { accepted: false, reason: 'not-pending' } });
    expect(lastLine(answeredCard(stale.card))).toBe(NOT_PENDING_TEXT);
    expect(taps).toEqual([]);
    // The claim card still takes its own answer.
    const fresh = await ix.handleInvoke(invoke(MO, executeAction(claim, 'dismiss'), claimId));
    expect(fresh.outcome).toEqual({ kind: 'tapped', card: 'claimed', choice: 'dismiss', outcome: { accepted: true, resumed: true } });
    expect(taps.map((t) => [t.card, t.choice, t.actor.id])).toEqual([['claimed', 'dismiss', MO]]);
  });
});

// Authorization -----------------------------------------------------------------------------------

describe('authorization (main 8.2, 11.2, 16)', () => {
  it("a reporter's Fix it reposts the card in the thread mentioning the owner, and says so on the card", async () => {
    await seedPlanned(1);
    const { outcome, response, card } = await tapOn(RAE, fixPreview(1), 'approve_fix');
    expect(outcome).toEqual({ kind: 'denied', action: 'approve_fix', reason: 'engineer-required', askedOwner: SAM });
    expect(taps).toEqual([]);
    // The tapper's answer: the same card, buttons kept, with the line.
    const answered = answeredCard(response);
    expect(answered.actions).toEqual(card.actions);
    expect(lastLine(answered)).toBe("I've asked <at>sam</at> to approve.");
    expect(mentioned(answered)).toContain(SAM);
    // The repost: a reply in the thread, led by the owner's mention, keeping the buttons.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe(`/amer/v3/conversations/${THREAD}/activities/${ROOT}`);
    const repost = (seen[0]?.body['attachments'] as { content: AdaptiveCard }[])[0]?.content;
    expect(repost?.body[0]?.text).toBe('<at>sam</at>, <at>rae</at> asked for a fix. Tap Fix it to approve.');
    expect(repost?.body.slice(1)).toEqual(card.body);
    expect(repost?.actions).toEqual(card.actions);
    expect(mentioned(repost as AdaptiveCard)).toEqual(expect.arrayContaining([SAM, RAE]));
    // Recorded as the fix preview (A 1.3) and remembered, so Sam's tap on it is answered in place.
    const posted = await lastOf('bot-message-posted');
    expect(posted?.payload).toMatchObject({ platform: 'teams', channel: CHANNEL, role: 'fix-preview' });
    const repostId = (posted?.payload as { messageId: string }).messageId;
    expect(await store.get(THREAD, repostId)).toEqual(repost);
    const bySam = await ix.handleInvoke(invoke(SAM, executeAction(card, 'approve_fix'), repostId));
    expect(bySam.outcome).toMatchObject({ kind: 'tapped', choice: 'approve_fix' });
    expect(lastLine(answeredCard(bySam.card))).toBe('<at>sam</at> chose Fix it.');
  });

  it("with no remembered card, a reporter's Fix it still reaches the owner: the thread gets the line that mentions them", async () => {
    await seedPlanned(1);
    const card = build(fixPreview(1));
    const { outcome, card: answer } = await ix.handleInvoke(invoke(RAE, executeAction(card, 'approve_fix'), '1790000999999'));
    expect(outcome).toEqual({ kind: 'denied', action: 'approve_fix', reason: 'engineer-required', askedOwner: SAM });
    expect(answer).toBeUndefined();
    expect(taps).toEqual([]);
    // A reply in the thread: the lead line alone (the card above keeps its buttons), mentioning Sam.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe(`/amer/v3/conversations/${THREAD}/activities/${ROOT}`);
    const lead = cardIn(seen[0]);
    expect(lead?.body.map((b) => b.text)).toEqual(['<at>sam</at>, <at>rae</at> asked for a fix. Tap Fix it to approve.']);
    expect(lead?.actions ?? []).toEqual([]);
    expect(mentioned(lead as AdaptiveCard)).toEqual(expect.arrayContaining([SAM, RAE]));
    expect((await lastOf('bot-message-posted'))?.payload).toMatchObject({ platform: 'teams', channel: CHANNEL, role: 'other' });
    expect(errors).toEqual([]);
  });

  it('a merge without a Teams-linked GitHub identity is refused and never reaches the PR actions', async () => {
    await seedPrOpen(2);
    const { outcome, response, card } = await tapOn(SAM, prReady, 'merge');
    expect(outcome).toEqual({ kind: 'denied', action: 'merge', reason: 'linked-identity-required' });
    expect(prCalls).toEqual([]);
    const answered = answeredCard(response);
    expect(lastLine(answered)).toMatch(/Link your GitHub account/);
    expect(answered.actions).toEqual(card.actions);
  });

  it('a linked engineer merges, requests changes, and reverts as themselves, on the PR and commit each card showed (#264)', async () => {
    await seedPrOpen(2);
    linked.add(SAM);
    expect((await tapOn(SAM, prReady, 'merge')).outcome).toEqual({ kind: 'pr-action', action: 'merge', incidentId: INC });
    expect((await tapOn(SAM, prReady, 'request_changes')).outcome).toMatchObject({ kind: 'pr-action', action: 'request_changes' });
    const status = buildStatusCard(INC, makeStatusUpdate('merged', { issueKey: 'WEB-1042', automatic: true, pin: { prNumber: 77, sha: MERGE_COMMIT } }));
    const statusId = await post(status);
    const reverted = await ix.handleInvoke(invoke(SAM, executeAction(status, 'revert'), statusId));
    expect(reverted.outcome).toMatchObject({ kind: 'pr-action', action: 'revert' });
    const input = { incidentId: INC, actor: { id: SAM, role: 'engineer' }, prNumber: 77, sha: HEAD, repo: 'github.com/acme/web' };
    expect(prCalls).toEqual([
      { action: 'merge', input },
      { action: 'request_changes', input },
      { action: 'revert', input: { ...input, sha: MERGE_COMMIT } },
    ]);
    expect(lastLine(answeredCard(reverted.card))).toBe('<at>sam</at> reverted this.');
  });

  it('a PR button without the PR and commit its card showed reaches the PR actions without them, which refuse it as out of date (#264)', async () => {
    await seedPrOpen(2);
    linked.add(SAM);
    const old = buildStatusCard(INC, { ...makeStatusUpdate('merged', { issueKey: 'WEB-1042' }), actions: ['revert'] });
    const id = await post(old);
    await ix.handleInvoke(invoke(SAM, executeAction(old, 'revert'), id));
    expect(prCalls).toEqual([{ action: 'revert', input: { incidentId: INC, actor: { id: SAM, role: 'engineer' }, repo: 'github.com/acme/web' } }]);
  });

  const linkExpired = () =>
    new PrActionRefusedError({ done: false, action: 'merge', reason: 'not-linked', message: 'Your GitHub link has expired.', linkUrl: LINK_URL });

  it("a merge GitHub refuses (the link went dead) leaves the buttons and sends the relink URL to the tapper's personal chat", async () => {
    await seedPrOpen(2);
    linked.add(SAM);
    prBehavior = () => Promise.reject(linkExpired());
    const { outcome, response, card, id } = await tapOn(SAM, prReady, 'merge');
    expect(outcome).toEqual({ kind: 'pr-refused', action: 'merge', incidentId: INC, reason: 'not-linked' });
    const answered = answeredCard(response);
    expect(answered.actions).toEqual(card.actions);
    expect(lastLine(answered)).toBe(`Your GitHub link has expired. ${LINK_SENT_TEXT}`);
    // The URL is single use and bound to Sam: it is on no card, only behind a button in Sam's personal chat.
    expect(JSON.stringify(answered)).not.toContain(LINK_URL);
    expectLinkSentPrivately(SAM, LINK_URL);
    expect(edits()).toEqual([]);
    expect(await store.get(THREAD, id)).toEqual(card);
  });

  it('when the personal chat cannot be opened, the card says so and the relink URL goes nowhere', async () => {
    await seedPrOpen(2);
    linked.add(SAM);
    prBehavior = () => Promise.reject(linkExpired());
    server.use(http.post(`${V3}/conversations`, () => HttpResponse.json({ error: { code: 'BotNotInConversationRoster' } }, { status: 403 })));
    const { response } = await tapOn(SAM, prReady, 'merge');
    const answered = answeredCard(response);
    expect(lastLine(answered)).toBe(`Your GitHub link has expired. ${LINK_NOT_SENT_TEXT}`);
    expect(JSON.stringify(answered)).not.toContain(LINK_URL);
    expect(seen).toEqual([]);
    expect(errors).toEqual([expect.any(Error)]);
  });

  it('a reporter cannot request changes, even when linked', async () => {
    await seedPrOpen(2);
    linked.add(RAE);
    expect((await tapOn(RAE, prReady, 'request_changes')).outcome).toEqual({ kind: 'denied', action: 'request_changes', reason: 'engineer-required' });
    expect(prCalls).toEqual([]);
  });
});

// Stop --------------------------------------------------------------------------------------------

describe('stop and dismiss through stopIncident (main 8.2)', () => {
  it('Stop on the level 3 fix preview: stopped by the tapper from Teams, the run cancelled', async () => {
    await seedFixing(3);
    const { outcome, response } = await tapOn(RAE, fixPreview(3), 'stop');
    expect(outcome).toEqual({ kind: 'stopped', incidentId: INC, outcome: { stopped: true, cancelledRun: RUN } });
    const stopped = await lastOf('stopped');
    expect(stopped?.actor).toEqual({ id: RAE, role: 'reporter' });
    expect(stopped?.source).toBe('teams');
    expect(cancelled).toEqual([RUN]);
    expect(taps).toEqual([]);
    expect(lastLine(answeredCard(response))).toBe('<at>rae</at> stopped this.');
  });

  it("Not a bug at level 2 is a Stop plus a Won't Do close through the outbox", async () => {
    await seedFixing(2);
    const { outcome, response } = await tapOn(RAE, fixPreview(2), 'dismiss');
    expect(outcome).toEqual({ kind: 'stopped', incidentId: INC, outcome: { stopped: true, cancelledRun: RUN }, wontDo: true });
    expect((await types()).slice(-2)).toEqual(['stopped', 'not-a-bug']);
    expect((await lastOf('not-a-bug'))?.source).toBe('teams');
    const transitions = (await state.drainOutbox('jira', 100)).filter((r) => r.op === 'transition').map((r) => r.payload);
    expect(transitions).toContainEqual({ issueKey: 'WEB-1042', to: 'done', resolution: JIRA_RESOLUTION_WONT_DO });
    expect(lastLine(answeredCard(response))).toBe('<at>rae</at> marked this Not a bug.');
  });

  it('Stop on the status message at level 1 with nothing running is refused', async () => {
    await seedPlanned(1);
    const status = buildStatusCard(INC, { ...makeStatusUpdate('filed', { issueKey: 'WEB-1042' }), actions: ['stop'] });
    const id = await post(status);
    const { outcome, card: response } = await ix.handleInvoke(invoke(SAM, executeAction(status, 'stop'), id));
    expect(outcome).toEqual({ kind: 'denied', action: 'stop', reason: 'nothing-to-stop' });
    expect(await types()).not.toContain('stopped');
    expect(lastLine(answeredCard(response))).toBe('Nothing is running for this incident yet.');
  });
});

// Mid-flight --------------------------------------------------------------------------------------

describe('the mid-flight card through answerMidFlight (A 2.2)', () => {
  it('Let it finish', async () => {
    await seedFixing(2);
    const { outcome, response } = await tapOn(SAM, midFlight, 'let_it_finish');
    expect(outcome).toEqual({ kind: 'mid-flight', incidentId: INC, answer: { accepted: true, choice: 'let-it-finish' } });
    expect(lastLine(answeredCard(response))).toBe('<at>sam</at> chose Let it finish. The fixer keeps going.');
    expect(cancelled).toEqual([]);
  });

  it("Stop it, I'll take over: the run stops and the claimer is assigned", async () => {
    await seedFixing(2);
    const { outcome, response } = await tapOn(SAM, midFlight, 'stop_it');
    expect(outcome).toMatchObject({ kind: 'mid-flight', answer: { accepted: true, choice: 'stop-it', stop: { stopped: true } } });
    expect(cancelled).toEqual([RUN]);
    expect(assigned).toEqual([SAM]);
    expect(lastLine(answeredCard(response))).toBe('<at>sam</at> stopped the fixer before it pushed anything. <at>sam</at> has the ticket.');
  });

  it('a tap after the run ended is refused on the card', async () => {
    await seedPrOpen(2);
    const { outcome, response, card } = await tapOn(SAM, midFlight, 'stop_it');
    expect(outcome).toEqual({ kind: 'mid-flight', incidentId: INC, answer: { accepted: false, reason: 'run-finished' } });
    expect(cancelled).toEqual([]);
    const answered = answeredCard(response);
    expect(answered.actions).toEqual(card.actions);
    expect(lastLine(answered)).toBe('That fixer run has already finished.');
  });

  it('a reporter cannot answer it', async () => {
    await seedFixing(2);
    expect((await tapOn(RAE, midFlight, 'stop_it')).outcome).toMatchObject({ answer: { accepted: false, reason: 'engineer-required' } });
  });
});

// Unknown incidents and other invokes -----------------------------------------------------------

describe('a tap on an unknown incident, and invokes that are not taps', () => {
  it('Stop, a PR button, and a card choice on an incident with no log change nothing', async () => {
    const stop = buildStatusCard(UNKNOWN_INC, { ...makeStatusUpdate('fixing', { issueKey: 'WEB-1' }), actions: ['stop'] });
    const stopId = await post(stop);
    const stopped = await ix.handleInvoke(invoke(SAM, executeAction(stop, 'stop'), stopId));
    expect(stopped.outcome).toEqual({ kind: 'ignored', reason: 'unknown-incident' });
    expect(lastLine(answeredCard(stopped.card))).toBe('This card already has an answer.');

    linked.add(SAM);
    const pr = build(prReady, UNKNOWN_INC);
    const merged = await ix.handleInvoke(invoke(SAM, executeAction(pr, 'merge'), await post(pr)));
    expect(merged.outcome).toEqual({ kind: 'ignored', reason: 'unknown-incident' });

    const fix = build(fixPreview(1), UNKNOWN_INC);
    const dismissed = await ix.handleInvoke(invoke(SAM, executeAction(fix, 'dismiss'), await post(fix)));
    expect(dismissed.outcome).toEqual({ kind: 'tapped', card: 'fix-preview', choice: 'dismiss', outcome: { accepted: false, reason: 'not-pending' } });
    expect(lastLine(answeredCard(dismissed.card))).toBe('This card already has an answer.');
    expect(prCalls).toEqual([]);
    expect(cancelled).toEqual([]);
    expect(await state.read(UNKNOWN_INC)).toEqual([]);
  });

  it('ignores other activities, Action.Submit, malformed taps, and the text-signal cards', async () => {
    expect((await ix.handleInvoke({ type: 'message', text: 'hi' })).outcome).toEqual({ kind: 'ignored', reason: 'not-a-card-action' });
    const submit = invoke(SAM, { verb: 'stop', data: { incidentId: INC } }, undefined);
    (submit['value'] as { action: { type: string } }).action.type = 'Action.Submit';
    expect((await ix.handleInvoke(submit)).outcome).toEqual({ kind: 'ignored', reason: 'not-execute' });
    expect((await ix.handleInvoke(invoke(SAM, { verb: 'stop', data: { incidentId: '' } }, undefined))).outcome).toEqual({ kind: 'ignored', reason: 'malformed' });
    const resolution = buildCard(INC, {
      kind: 'resolution',
      userId: RAE,
      issueKey: 'WEB-1042',
      resolution: 'Cannot Reproduce',
      messageId: '1790000100555',
      text: 'Close WEB-1042 as Cannot Reproduce?',
      choices: ['close', 'keep-open'],
    });
    const id = await post(resolution);
    const out = await ix.handleInvoke(invoke(RAE, executeAction(resolution, 'close'), id));
    expect(out.outcome).toEqual({ kind: 'ignored', reason: 'text-signal-card' });
    expect(answeredCard(out.card)).toEqual(resolution);
    expect(taps).toEqual([]);
  });
});

// The text-signal cards (A 3) -----------------------------------------------------------------------

describe('the text-signal cards through answerResolution and answerScopeChange (A 3)', () => {
  const ASKED = '1790000100555';
  const SECOND = '1790000100556';
  let posted: { card: AdaptiveCard; id: string }[];
  let filedLinked: LinkedIncidentRequest[];

  /** The text signals over the store; their cards go up through the remembering connector, as compose wires them. */
  function textDeps(): TextSignalDeps {
    const put = async (c: AdaptiveCard): Promise<string> => {
      const id = await post(c);
      posted.push({ card: c, id });
      return id;
    };
    return {
      workspaceId: WS,
      state,
      playbook: defaultPlaybook(),
      clock: () => new Date(now),
      proposalWait: { maxMs: 0 },
      ports: {
        askResolution: async (incidentId, prompt) => void (await put(build({ ...prompt, kind: 'resolution' }, incidentId))),
        postScopeCard: async (incidentId, c) => ({ platform: 'teams', channel: CHANNEL, messageId: await put(build(c, incidentId)), role: 'other' }),
        fileLinked: (request) => (filedLinked.push(request), Promise.resolve({ incidentId: '01K6TEAMSTAP0000000000002' })),
        assign: () => Promise.resolve(),
      },
    };
  }

  /** Rae says `text` in the incident's thread, as the signals hand it over. */
  async function rae(deps: TextSignalDeps, id: string, text: string) {
    return handleTextSignal(deps, {
      platform: 'teams',
      thread: { channel: CHANNEL, rootId: ROOT },
      message: { id, authorId: RAE, text, timestamp: new Date(now).toISOString() },
      actor: { id: RAE, name: 'rae', role: 'reporter' },
    });
  }

  beforeEach(async () => {
    posted = [];
    filedLinked = [];
    await seedPlanned(1);
    await append([ev('filed', { jiraKey: 'WEB-1042' })]);
  });

  it('the resolution question: only its asker answers; Close it closes the incident and the card says so for everyone', async () => {
    const deps = textDeps();
    ix = make({ text: deps });
    expect(await rae(deps, ASKED, 'nvm, works now')).toMatchObject({ handled: true, effect: 'resolution-asked' });
    const [question] = posted;
    if (question === undefined) throw new Error('no resolution question');
    expect(executeAction(question.card, 'close').data).toEqual({ incidentId: INC, messageId: ASKED });

    // Sam was not asked: told why on his view of the card, and nothing is edited.
    const bySam = await ix.handleInvoke(invoke(SAM, executeAction(question.card, 'close'), question.id));
    expect(bySam.outcome).toEqual({ kind: 'text-signal', incidentId: INC, choice: 'close', outcome: { handled: false, reason: 'not-allowed' } });
    expect(lastLine(answeredCard(bySam.card))).toBe('Only the person it asked, the reporter, or an engineer can answer this.');
    expect(answeredCard(bySam.card).actions).toEqual(question.card.actions);
    expect(seen).toEqual([]);

    const byRae = await ix.handleInvoke(invoke(RAE, executeAction(question.card, 'close'), question.id));
    expect(byRae.outcome).toMatchObject({ kind: 'text-signal', incidentId: INC, choice: 'close', outcome: { handled: true, effect: 'closed' } });
    const closed = answeredCard(byRae.card);
    expect(lastLine(closed)).toBe('Closed WEB-1042.');
    expect(closed.actions).toBeUndefined();
    expect(edits()).toEqual([{ path: cardPath(question.id), card: closed }]);
    expect(await types()).toContain('closed');
    expect(taps).toEqual([]);
  });

  it('the scope-change card: Yes files the second issue on Teams, the card names who chose, and a second answer is refused', async () => {
    const deps = textDeps();
    ix = make({ text: deps });
    expect(await rae(deps, SECOND, 'same thing on the app too')).toMatchObject({ handled: true, effect: 'scope-proposed' });
    const [scopeCard] = posted;
    if (scopeCard === undefined) throw new Error('no scope-change card');

    const bySam = await ix.handleInvoke(invoke(SAM, executeAction(scopeCard.card, 'yes'), scopeCard.id));
    expect(bySam.outcome).toMatchObject({ kind: 'text-signal', choice: 'yes', outcome: { handled: true, effect: 'scope-split' } });
    expect(filedLinked).toEqual([expect.objectContaining({ parentIncidentId: INC, platform: 'teams', channel: CHANNEL, messageId: SECOND, reporter: expect.objectContaining({ id: RAE }) })]);
    const chosen = answeredCard(bySam.card);
    expect(lastLine(chosen)).toBe('<at>sam</at> chose Yes.');
    expect(mentioned(chosen)).toContain(SAM);
    expect(edits()).toEqual([{ path: cardPath(scopeCard.id), card: chosen }]);

    seen = [];
    const again = await ix.handleInvoke(invoke(RAE, executeAction(scopeCard.card, 'same-bug'), scopeCard.id));
    expect(again.outcome).toMatchObject({ kind: 'text-signal', choice: 'same-bug', outcome: { handled: false, reason: 'already-decided' } });
    expect(lastLine(answeredCard(again.card))).toBe('This question already has an answer.');
    expect(seen).toEqual([]);
    expect(filedLinked).toHaveLength(1);
  });
});

// onAction, the transport's handler --------------------------------------------------------------

describe('onAction, as the transport calls it', () => {
  it('an accepted tap edits the shared message for everyone, answers with the same card, and is reported to onOutcome', async () => {
    await seedPrOpen(2);
    linked.add(SAM);
    const card = build(prReady);
    const id = await post(card);
    const answer = await ix.onAction(invoke(SAM, executeAction(card, 'merge'), id));
    expect(lastLine(answeredCard(answer))).toBe('<at>sam</at> merged this.');
    expect(answer?.actions).toBeUndefined();
    // The answer updates only Sam's view; the edit is what everyone else sees, however fast the tap was.
    expect(edits()).toEqual([{ path: cardPath(id), card: answer }]);
    expect(outcomes).toEqual([{ kind: 'pr-action', action: 'merge', incidentId: INC }]);
    expect(errors).toEqual([]);
  });

  it('a refusal answers the tapper alone and never edits the shared message', async () => {
    await seedPrOpen(2);
    linked.add(SAM);
    prBehavior = () => Promise.reject(new PrActionRefusedError({ done: false, action: 'merge', reason: 'head-moved', message: 'The PR changed; look again.' }));
    const card = build(prReady);
    const id = await post(card);
    const answer = await ix.onAction(invoke(SAM, executeAction(card, 'merge'), id));
    expect(lastLine(answeredCard(answer))).toBe('The PR changed; look again.');
    expect(answer?.actions).toEqual(card.actions);
    expect(seen).toEqual([]);
    expect(await store.get(THREAD, id)).toEqual(card);
  });

  it('a slow refusal with a relink URL never puts it on the shared message; the tapper gets it privately', async () => {
    await seedPrOpen(2);
    linked.add(SAM);
    // Past the transport's budget the answer card may never be shown; the personal chat still is.
    prBehavior = () =>
      new Promise<void>((_resolve, reject) =>
        setTimeout(
          () => reject(new PrActionRefusedError({ done: false, action: 'merge', reason: 'not-linked', message: 'Your GitHub link has expired.', linkUrl: LINK_URL })),
          40,
        ),
      );
    const card = build(prReady);
    const id = await post(card);
    const answer = await ix.onAction(invoke(SAM, executeAction(card, 'merge'), id));
    expect(edits()).toEqual([]);
    expect(seen.filter((s) => s.path.startsWith(`/amer/v3/conversations/${CHANNEL}`))).toEqual([]);
    expect(JSON.stringify(answer)).not.toContain(LINK_URL);
    expectLinkSentPrivately(SAM, LINK_URL);
    expect(await store.get(THREAD, id)).toEqual(card);
    expect(outcomes).toEqual([{ kind: 'pr-refused', action: 'merge', incidentId: INC, reason: 'not-linked' }]);
  });

  it('a refusal that lands past the budget reaches the tapper in their personal chat; one inside it, or an accepted tap, does not', async () => {
    await seedPrOpen(2);
    linked.add(RAE);
    const card = build(prReady);
    const id = await post(card);
    // Inside the budget the answer card carries the reason: nothing private.
    const inside = await ix.onAction(invoke(RAE, executeAction(card, 'request_changes'), id), { expired: () => false });
    expect(lastLine(answeredCard(inside))).toBe('Only an engineer on this surface can do that.');
    expect(seen).toEqual([]);

    // Past it the transport already said "Working on it": the reason goes to Rae's personal chat.
    await ix.onAction(invoke(RAE, executeAction(card, 'request_changes'), id), { expired: () => true });
    const opened = seen.filter((s) => s.path === '/amer/v3/conversations');
    expect(opened.map((s) => s.body)).toEqual([expect.objectContaining({ isGroup: false, members: [{ id: `29:${RAE}`, aadObjectId: RAE }], tenantId: TENANT })]);
    const told = seen.filter((s) => s.path === PERSONAL_PATH).map((s) => cardIn(s)?.body.map((b) => b.text));
    expect(told).toEqual([['You tapped Request changes. Only an engineer on this surface can do that.']]);
    expect(edits()).toEqual([]);

    // An accepted tap past the budget is seen through its edit in place: nothing private.
    seen = [];
    linked.add(SAM);
    await ix.onAction(invoke(SAM, executeAction(card, 'merge'), id), { expired: () => true });
    expect(seen.filter((s) => s.method !== 'PUT')).toEqual([]);
    expect(edits()).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('an edit in place that fails does not fail the tap, and the card is still remembered as answered', async () => {
    await seedPlanned(1);
    server.use(http.put(`${V3}/conversations/:conversation/activities/:activityId`, () => HttpResponse.json({ error: { code: 'ServiceError' } }, { status: 500 })));
    const card = build(scope);
    const id = await post(card);
    const answer = await ix.onAction(invoke(RAE, executeAction(card, 'looks-right'), id));
    expect(lastLine(answeredCard(answer))).toBe('<at>rae</at> chose Looks right.');
    expect(errors).toEqual([expect.any(Error)]);
    expect(await store.get(THREAD, id)).toEqual(answer);
  });

  it("a tap whose work fails rejects, so the transport answers with its error", async () => {
    await seedPrOpen(2);
    linked.add(SAM);
    prBehavior = () => Promise.reject(new Error('github is down'));
    const card = build(prReady);
    await expect(ix.onAction(invoke(SAM, executeAction(card, 'merge'), await post(card)))).rejects.toThrow('github is down');
  });
});

// What a tap acts on (#269) -------------------------------------------------------------------------

describe("a tap acts on its remembered card's data, or on an incident in the conversation tapped (#269)", () => {
  const OTHER_INC = '01K6TEAMSTAP0000000000002';
  const OTHER_CHANNEL = '19:9e8d7c6b5a4f3e2d1c0b@thread.tacv2';
  let logged: string[];

  beforeEach(() => {
    logged = [];
    ix = make({ log: (line) => logged.push(line) });
  });

  /** `activity` as if tapped in another conversation; `channelData` keeps naming the incident's channel. */
  function inConversation(activity: Record<string, unknown>, conversation: Record<string, unknown>): Record<string, unknown> {
    return { ...activity, conversation: { tenantId: TENANT, ...conversation } };
  }

  it('a button whose data names another incident than the remembered button does nothing, with one log line', async () => {
    await seedPlanned(1);
    const card = build(scope);
    const id = await post(card);
    const forged = await ix.handleInvoke(invoke(RAE, { verb: 'looks-right', data: { incidentId: OTHER_INC } }, id));
    expect(forged).toEqual({ outcome: { kind: 'ignored', reason: 'tap-mismatch' } });
    expect(taps).toEqual([]);
    expect(seen).toEqual([]);
    expect(await store.get(THREAD, id)).toEqual(card);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`incident ${OTHER_INC}`);
    expect(logged[0]).toContain('another incident');
  });

  it("the remembered button's data is what the tap acts on, whatever else the invoke carries", async () => {
    await seedFixing(2);
    const card = build(midFlight);
    const id = await post(card);
    const button = executeAction(card, 'stop_it');
    expect(button.data).toMatchObject({ runId: RUN, claimerId: SAM });
    // The invoke names another run and another claimer: the card's run stops and the card's claimer takes over.
    const out = await ix.handleInvoke(invoke(SAM, { verb: 'stop_it', data: { ...button.data, runId: 'run-forged', claimerId: MO } }, id));
    expect(out.outcome).toMatchObject({ kind: 'mid-flight', incidentId: INC, answer: { accepted: true, choice: 'stop-it' } });
    expect(cancelled).toEqual([RUN]);
    expect(assigned).toEqual([SAM]);

    // A clarify mark the status message's Stop never carried does not make the Stop a clarify answer.
    const status = buildStatusCard(INC, { ...makeStatusUpdate('fixing', { issueKey: 'WEB-1042' }), actions: ['stop'] });
    const statusId = await post(status);
    const stop = await ix.handleInvoke(invoke(SAM, { verb: 'stop', data: { incidentId: INC, card: 'clarify' } }, statusId));
    expect(stop.outcome).toMatchObject({ kind: 'stopped', incidentId: INC });
    expect(taps).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('with no remembered card, a tap naming an incident of another conversation, or no incident, does nothing', async () => {
    await seedPlanned(1);
    const card = build(scope);
    const choice = executeAction(card, 'looks-right');
    // Tapped in another channel's thread; the channel data the client sends still names the incident's channel.
    const other = inConversation(invoke(RAE, choice, undefined), { isGroup: true, conversationType: 'channel', id: `${OTHER_CHANNEL};messageid=${ROOT}` });
    expect((await ix.handleInvoke(other)).outcome).toEqual({ kind: 'ignored', reason: 'tap-mismatch' });
    // A card in the tapper's personal chat is no card choice's.
    const personal = inConversation(invoke(RAE, choice, '1790000999999'), { conversationType: 'personal', id: PERSONAL });
    expect((await ix.handleInvoke(personal)).outcome).toEqual({ kind: 'ignored', reason: 'tap-mismatch' });
    const unknown = await ix.handleInvoke(invoke(RAE, { verb: 'looks-right', data: { incidentId: UNKNOWN_INC } }, undefined));
    expect(unknown).toEqual({ outcome: { kind: 'ignored', reason: 'tap-mismatch' } });
    expect(taps).toEqual([]);
    expect(seen).toEqual([]);
    expect(logged).toHaveLength(3);
    expect(logged[0]).toContain('not in the conversation tapped');
    expect(logged[2]).toContain('no such incident');
    // The same tap in the incident's own thread goes through.
    expect((await ix.handleInvoke(invoke(RAE, choice, undefined))).outcome).toMatchObject({ kind: 'tapped', card: 'scope-preview', choice: 'looks-right' });
  });

  it("a queue card's Stop in the tapper's personal chat goes through with no remembered card", async () => {
    await seedFixing(2);
    const stop = inConversation(invoke(SAM, { verb: 'stop', data: { incidentId: INC } }, '1790000999999'), { conversationType: 'personal', id: PERSONAL });
    const out = await ix.handleInvoke(stop);
    expect(out.outcome).toEqual({ kind: 'stopped', incidentId: INC, outcome: { stopped: true, cancelledRun: RUN } });
    expect(cancelled).toEqual([RUN]);
    expect(logged).toEqual([]);
  });
});

// The remembering connector -----------------------------------------------------------------------

describe('rememberTeamsCards', () => {
  it('keeps posted cards with Action.Execute buttons and every card edited in place, by channel and activity', async () => {
    const withButtons = build(scope);
    const id = await post(withButtons);
    expect(await store.get(CHANNEL, id)).toEqual(withButtons);
    expect(await kvOf(state).get(teamsCardKey(THREAD, id))).not.toBeNull();

    const plain = buildStatusCard(INC, makeStatusUpdate('filed', { issueKey: 'WEB-1042' }));
    const plainId = await post(plain);
    expect(await store.get(CHANNEL, plainId)).toBeUndefined();

    await connector.updateActivity({ serviceUrl: SERVICE_URL, conversationId: THREAD, activityId: id }, cardActivity(plain));
    expect(await store.get(CHANNEL, id)).toEqual(plain);
  });
});
