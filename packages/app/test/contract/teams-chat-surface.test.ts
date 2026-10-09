// The Teams chat surface (#10; main 11.2, main 15.2, A 1.4, A 2.2, A 3, A 4.4, A 4.6, A 5.3, A 6.2): every
// outbound effect compose performs, over the Bot Connector and Graph on MSW and a real store on the dialect
// `SNAPWING_DB` selects. Per effect: a thread post (recorded role `other` by the router), a channel post by
// map name or id, a person post in the personal chat with the thread fallback, the PR card (role `pr`) and
// the GitHub link prompt, the resolution prompt, the scope-change card, the mid-flight card, and channel
// members from Graph. Also a person without a personal install, a channel without the grant, and mention
// tags inside user text, which never become mentions.

import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { EventPayloads, EventType, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { PrReadyCard } from '@snapwing/pipeline/contracts/adapters.ts';
import type { MidFlightCard } from '@snapwing/pipeline/fixer/claims.ts';
import { parseWorkspaceMap } from '@snapwing/pipeline/map/parse.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { renderDigest } from '@snapwing/pipeline/notify/digest.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { createKvCache } from '@snapwing/pipeline/providers/local/cache.ts';
import type { StateStore } from '@snapwing/pipeline/state/store.ts';
import { channelMembersKey } from '@snapwing/pipeline/state/projections/notify-context.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { createChatRouter, type ChatRouter } from '../../src/server/chat.ts';
import { rememberTeamsConversation, writeTeamsMode } from '../../src/adapters/teams/conversations.ts';
import { createTeamsChatSurface, teamsUserKey, type TeamsChatSurface } from '../../src/adapters/teams/chat-surface.ts';
import { CHANNEL_MEMBERS_REFRESH_MS, CHANNEL_MEMBERS_TTL_SEC } from '../../src/adapters/teams/channel-members.ts';
import { createTeamsConnector } from '../../src/adapters/teams/connector.ts';
import { createTeamsGraph } from '../../src/adapters/teams/graph.ts';

const exampleXml = readFileSync(new URL('../../../../examples/workspace-context.example.xml', import.meta.url), 'utf8');

const T0 = Date.parse('2026-10-03T10:00:00.000Z');
const WS = '01K6WORKSPACE0000000000000';
const SERVICE_URL = 'https://smba.test/amer/';
const V3 = 'https://smba.test/amer/v3';
const G = 'https://graph.microsoft.com/v1.0';
const TENANT = 'tenant-1';
const BOT = 'bot-app-id';
const TEAM = '8b2f6c1e-5d3a-4c7b-9e10-2a4f6b8c0d12';
const CHANNEL = '19:3f9a2c7e1b4d4e8f9a0b1c2d3e4f5a6b@thread.tacv2';
const ROOT = '1790000100001';
const DEV_AAD = '5c1d7e3a-92b4-4f60-8a1e-3d5b7c9e1f24';
const DEV_29 = '29:1Zk3v7Lq0w9XyN2bTqRm4cJdP8sAeHfUoVgKiB5nYtXr';
const REVIEWER_AAD = '6e2f8b4c-1d7a-4c93-b5e0-9a3d1f7c2e68';
const NOINSTALL_AAD = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const PERSONAL = '19:5c1d7e3a_personal@unq.gbl.spaces';
const POSTED = '1790000300001';

let map: WorkspaceMap;
beforeAll(async () => {
  const parsed = await parseWorkspaceMap(exampleXml);
  map = {
    ...parsed,
    people: [
      ...parsed.people,
      { teamsId: REVIEWER_AAD, handle: 'teamsReviewer', email: 'lee@example.com', role: 'engineer', owns: [] },
      { teamsId: NOINSTALL_AAD, handle: 'noInstall', email: 'sam@example.com', role: 'engineer', owns: [] },
    ],
  };
});

const server = setupServer();
beforeAll(() => server.listen());
afterAll(() => server.close());

interface Call {
  method: string;
  /** The decoded path under `/v3/`. */
  path: string;
  auth: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test inspection of recorded JSON bodies
  body: any;
}

let tdb: TestDatabase;
let state: OpenedState;
let calls: Call[];
let logs: string[];
let errors: string[];
let linked: Set<string>;
let installed: Set<string>;
let surface: TeamsChatSurface;
let router: ChatRouter;
let graphMembers: Map<string, () => Response>;

function incidentEvents(id: string, opts: { channelId: string; anchorId?: string; threadId?: string }): NewEvent<EventType>[] {
  return [
    {
      workspaceId: WS,
      incidentId: id,
      type: 'captured',
      v: 1,
      source: 'agent',
      occurredAt: new Date(T0).toISOString(),
      payload: {
        kind: 'incident',
        idempotencyKey: `teams-chat-${id}`,
        source: 'teams',
        reporter: { id: DEV_AAD, name: 'teamsDev', role: 'engineer' },
        anchorText: 'checkout is broken',
        ...(opts.anchorId === undefined ? {} : { anchorId: opts.anchorId }),
        ...(opts.threadId === undefined ? {} : { threadId: opts.threadId }),
        channelId: opts.channelId,
        rawPayloadSnapshot: { type: 'message', text: 'checkout is broken' },
      } satisfies EventPayloads['captured'],
    } as unknown as NewEvent<'captured'>,
  ];
}

async function seed(id: string, opts: { channelId: string; anchorId?: string; threadId?: string }): Promise<void> {
  await state.append(id, incidentEvents(id, opts), 0);
}

const INCIDENT = '01K6TEAMSCHAT00000000000001';
const DM_INCIDENT = '01K6TEAMSCHAT00000000000002';

function botRecords(events: { type: string; payload: unknown }[]): { channel: string; messageId: string; role: string; platform: string }[] {
  return events
    .filter((e) => e.type === 'bot-message-posted')
    .map((e) => e.payload as { channel: string; messageId: string; role: string; platform: string });
}

const prCard: PrReadyCard = {
  kind: 'pr-ready',
  prNumber: 418,
  headSha: 'e'.repeat(40),
  prUrl: 'https://github.com/acme/web/pull/418',
  issueKey: 'WEB-1042',
  reviewVerdict: 'approve',
  ciState: 'green',
  filesChanged: 2,
  additions: 41,
  deletions: 6,
  reviewerUserIds: [DEV_AAD],
};

const midFlight: MidFlightCard = {
  kind: 'mid-flight',
  issueKey: 'WEB-1042',
  claimerUserId: DEV_AAD,
  runId: '01K6RUN00000000000000000001',
  runAgeMs: 4 * 60_000,
  branch: 'fix/WEB-1042',
  choices: ['let-it-finish', 'stop-it'],
  grace: 'PT10M',
};

/** The cards a call carries. */
function cardOf(call: Call): { fallbackText: string; body: { text: string }[]; actions?: { type: string; title: string; verb?: string; url?: string; data?: Record<string, string> }[]; msteams?: { entities: { mentioned: { id: string; name: string } }[] } } {
  return call.body.attachments[0].content;
}

beforeEach(async () => {
  tdb = await createTestDatabase();
  state = await tdb.open({ now: () => new Date(T0) });
  calls = [];
  logs = [];
  errors = [];
  linked = new Set();
  installed = new Set([DEV_AAD, REVIEWER_AAD]);
  graphMembers = new Map();
  server.use(
    http.all(`${V3}/*`, async ({ request }) => {
      const url = new URL(request.url);
      const path = decodeURIComponent(url.pathname.replace(/^\/amer\/v3\//, ''));
      const body: unknown = request.method === 'GET' ? undefined : await request.json();
      calls.push({ method: request.method, path, auth: request.headers.get('authorization'), body });
      if (path === 'conversations') {
        const aad = (body as { members: { aadObjectId: string }[] }).members[0]?.aadObjectId ?? '';
        if (!installed.has(aad)) {
          return HttpResponse.json({ error: { code: 'BotNotInConversationRoster', message: 'The bot is not part of the conversation roster.' } }, { status: 403 });
        }
        return HttpResponse.json({ id: `${PERSONAL}-${aad.slice(0, 4)}`, activityId: '1790000200001', serviceUrl: SERVICE_URL });
      }
      return HttpResponse.json({ id: POSTED });
    }),
    http.get(`${G}/teams/:team/channels/:channel/members`, ({ params }) => {
      const make = graphMembers.get(String(params['channel']));
      return make === undefined ? HttpResponse.json({ error: { code: 'NotFound', message: 'no such channel' } }, { status: 404 }) : make();
    }),
  );
  const cache = createKvCache(state as unknown as StateStore);
  await rememberTeamsConversation(cache, {
    serviceUrl: SERVICE_URL,
    tenantId: TENANT,
    teamId: TEAM,
    channelId: CHANNEL,
    conversationType: 'channel',
    updatedAt: new Date(T0).toISOString(),
  });
  await seed(INCIDENT, { channelId: CHANNEL, anchorId: ROOT });
  await rememberTeamsConversation(cache, { serviceUrl: SERVICE_URL, tenantId: TENANT, channelId: PERSONAL, conversationType: 'personal', updatedAt: new Date(T0).toISOString() });
  await seed(DM_INCIDENT, { channelId: PERSONAL, anchorId: '1790000000009' });
  surface = createTeamsChatSurface({
    connector: createTeamsConnector({ token: async () => 'teams-test-token', botId: BOT }),
    graph: createTeamsGraph({ token: 'graph-test-token', maxPages: 5 }),
    state,
    cache,
    getMap: () => Promise.resolve(map),
    identity: { isLinked: (u) => Promise.resolve(u.chat === 'teams' && linked.has(u.userId)) },
    botId: BOT,
    tenantId: TENANT,
    serviceUrl: SERVICE_URL,
    now: () => new Date(T0),
    log: { info: (l) => logs.push(l), error: (l) => errors.push(l) },
  });
  router = createChatRouter({
    surfaces: [surface],
    state,
    map: () => Promise.resolve(map),
    clock: () => new Date(T0),
    log: { info: (l) => logs.push(l), error: (l) => errors.push(l) },
  });
});

afterEach(async () => {
  server.resetHandlers();
  expect(errors).toEqual([]);
  await tdb.drop();
});

describe('thread posts', () => {
  it('replies in the channel thread, with the root as the thread, and the router records role other', async () => {
    await router.threadPost(INCIDENT, { text: 'Still on it.' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', path: `conversations/${CHANNEL};messageid=${ROOT}/activities/${ROOT}`, auth: 'Bearer teams-test-token' });
    expect(calls[0]?.body).toMatchObject({ type: 'message', text: 'Still on it.', replyToId: ROOT });
    const records = botRecords(await state.read(INCIDENT));
    expect(records).toEqual([{ platform: 'teams', channel: CHANNEL, messageId: POSTED, role: 'other' }]);
  });

  it('posts in the chat itself, with no thread, for a personal-chat incident', async () => {
    await router.threadPost(DM_INCIDENT, { text: 'Filed WEB-1042.' });
    expect(calls[0]?.path).toBe(`conversations/${PERSONAL}/activities`);
    expect(botRecords(await state.read(DM_INCIDENT))).toEqual([{ platform: 'teams', channel: PERSONAL, messageId: POSTED, role: 'other' }]);
  });

  it('turns a map person into an <at> mention with an entity keyed by the AAD object id', async () => {
    await router.threadPost(INCIDENT, { text: 'Heads up @teamsDev, this is yours.', mentionUserId: DEV_AAD });
    const body = calls[0]?.body;
    expect(body.text).toBe('Heads up <at>teamsDev</at>, this is yours.');
    expect(body.entities).toEqual([{ type: 'mention', text: '<at>teamsDev</at>', mentioned: { id: DEV_AAD, name: 'teamsDev' } }]);
  });

  it('mentions a person by every reference a ladder step or digest uses', async () => {
    for (const ref of ['@teamsDev', 'ravi@example.com', DEV_AAD]) await surface.channelPost(CHANNEL, `${surface.mention(map, ref)} over to you`);
    await surface.channelPost(CHANNEL, `${surface.mentionUser(DEV_AAD)} over to you`);
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.body.text).toBe('<at>teamsDev</at> over to you');
      expect(call.body.entities).toEqual([{ type: 'mention', text: '<at>teamsDev</at>', mentioned: { id: DEV_AAD, name: 'teamsDev' } }]);
    }
    expect(surface.mention(map, '@nobody')).toBe('@nobody');
    expect(surface.mention(map, 'webDev1')).toBe('@webDev1');
  });

  it('mentions a person outside the map by the name Teams gave them, never by their raw id', async () => {
    const DANA = '7f3e9c1a-0000-4000-8000-00000000d001';
    // Before any activity from Dana, nothing names her: the id stays as given.
    await surface.channelPost(CHANNEL, `${surface.mentionUser(DANA)} is watching`);
    await surface.rememberUser({
      type: 'message',
      serviceUrl: SERVICE_URL,
      from: { id: '29:1dana-teams-id', aadObjectId: DANA, name: 'Dana Lee' },
      conversation: { id: 'a:1dana-personal', conversationType: 'personal', tenantId: TENANT },
    });
    expect(JSON.parse((await createKvCache(state as unknown as StateStore).get(teamsUserKey(DANA))) ?? '{}')).toMatchObject({ name: 'Dana Lee', teamsUserId: '29:1dana-teams-id' });
    await surface.channelPost(CHANNEL, `${surface.mentionUser(DANA)} is watching`);
    await surface.threadPost({ channel: CHANNEL, threadId: ROOT }, `Over to ${surface.mentionUser(DANA)}.`);
    expect(calls.map((c) => c.body.text)).toEqual([`@${DANA} is watching`, '<at>Dana Lee</at> is watching', 'Over to <at>Dana Lee</at>.']);
    for (const call of calls.slice(1)) expect(call.body.entities).toEqual([{ type: 'mention', text: '<at>Dana Lee</at>', mentioned: { id: DANA, name: 'Dana Lee' } }]);
  });

  it('skips an incident whose source is not Teams, as the router does for any source with no surface', async () => {
    const other = '01K6TEAMSCHAT00000000000003';
    await state.append(
      other,
      incidentEvents(other, { channelId: 'C0WEBBUGS', anchorId: '1759395600.000200' }).map((e) => ({ ...e, payload: { ...e.payload, source: 'slack' } }) as NewEvent<EventType>),
      0,
    );
    await router.threadPost(other, { text: 'hello' });
    expect(calls).toEqual([]);
    expect(logs.some((l) => l.includes('has no chat surface'))).toBe(true);
  });
});

describe('channel and person posts', () => {
  it('posts to a channel by its map name and by its id', async () => {
    await surface.channelPost('#web-bugs-teams', 'Weekly digest');
    await surface.channelPost(CHANNEL, 'Digest again');
    expect(calls.map((c) => c.path)).toEqual([`conversations/${CHANNEL}/activities`, `conversations/${CHANNEL}/activities`]);
    expect(calls.map((c) => c.body.text)).toEqual(['Weekly digest', 'Digest again']);
  });

  it('posts a person in their personal chat, with the 29: id from their last activity in members and the bot id', async () => {
    await surface.rememberUser({
      type: 'message',
      serviceUrl: SERVICE_URL,
      from: { id: DEV_29, aadObjectId: DEV_AAD, name: 'Ravi' },
      conversation: { id: PERSONAL, conversationType: 'personal', tenantId: TENANT },
      channelData: { tenant: { id: TENANT } },
    });
    await surface.personPost('@teamsDev', 'Your digest');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.path).toBe('conversations');
    expect(calls[0]?.body).toMatchObject({
      isGroup: false,
      members: [{ id: DEV_29, aadObjectId: DEV_AAD }],
      bot: { id: BOT },
      tenantId: TENANT,
    });
    expect(calls[1]?.path).toBe(`conversations/${PERSONAL}-5c1d/activities`);
    expect(calls[1]?.body.text).toBe('Your digest');
    expect(JSON.parse((await createKvCache(state as unknown as StateStore).get(teamsUserKey(DEV_AAD))) ?? '{}')).toMatchObject({ teamsUserId: DEV_29, serviceUrl: SERVICE_URL, tenantId: TENANT });
  });

  it('falls back to the AAD object id in members when no activity gave a 29: id, and reaches an email or an id', async () => {
    await surface.personPost('ravi@example.com', 'by email');
    await surface.personPost(REVIEWER_AAD, 'by id');
    const opened = calls.filter((c) => c.path === 'conversations');
    expect(opened.map((c) => c.body.members)).toEqual([[{ id: DEV_AAD, aadObjectId: DEV_AAD }], [{ id: REVIEWER_AAD, aadObjectId: REVIEWER_AAD }]]);
  });

  it('a person without a personal install is not posted anywhere public: an info log and no channel post', async () => {
    await surface.personPost('@noInstall', 'Your digest');
    expect(calls.map((c) => c.path)).toEqual(['conversations']);
    expect(logs.some((l) => l.includes(NOINSTALL_AAD) && l.includes('not installed'))).toBe(true);
    expect(logs.some((l) => l.includes(NOINSTALL_AAD) && l.includes('dropped'))).toBe(true);
  });

  it('a 400 from sending into a chat that opened throws and posts nothing publicly', async () => {
    server.use(
      http.post(`${V3}/conversations/${PERSONAL}-5c1d/activities`, async ({ request }) => {
        calls.push({ method: request.method, path: decodeURIComponent(new URL(request.url).pathname.replace(/^\/amer\/v3\//, '')), auth: null, body: await request.json() });
        return HttpResponse.json({ error: { code: 'BadArgument', message: 'bad payload' } }, { status: 400 });
      }),
    );
    await expect(surface.personPost('@teamsDev', 'Your digest')).rejects.toMatchObject({ status: 400, operation: 'sendToConversation' });
    expect(calls.map((c) => c.path)).toEqual(['conversations', `conversations/${PERSONAL}-5c1d/activities`]);
    expect(calls.some((c) => c.path.includes(CHANNEL))).toBe(false);
    expect(logs.some((l) => l.includes('not installed'))).toBe(false);
  });

  it('a person post with no tenant to open a chat in is dropped with an info log', async () => {
    const bare = createTeamsChatSurface({
      connector: createTeamsConnector({ token: async () => 'teams-test-token' }),
      graph: createTeamsGraph({ token: 'graph-test-token' }),
      state,
      cache: createKvCache(state as unknown as StateStore),
      getMap: () => Promise.resolve({ ...map, channels: map.channels.filter((c) => c.platform !== 'teams') }),
      identity: { isLinked: () => Promise.resolve(false) },
      log: { info: (l) => logs.push(l), error: (l) => errors.push(l) },
    });
    await bare.personPost('@teamsDev', 'hello');
    expect(calls).toEqual([]);
    expect(logs.some((l) => l.includes('no serviceUrl or tenant'))).toBe(true);
  });
});

describe('mention tags inside user text', () => {
  // An incident summary, a digest line, and a task summary are user text: a tag in one is shown as
  // text with no entity, so it notifies nobody. Only what `mention` and `mentionUser` return is a mention.
  const SPOOF = 'Checkout fails, ask <at>teamsReviewer</at> or <@U0WEBDEV1>';
  const SHOWN = 'Checkout fails, ask &lt;at&gt;teamsReviewer&lt;/at&gt; or &lt;@U0WEBDEV1&gt;';
  const DEV_ENTITY = { type: 'mention', text: '<at>teamsDev</at>', mentioned: { id: DEV_AAD, name: 'teamsDev' } };

  it('an escalation step mentions its own person, never one the incident summary names', async () => {
    await router.escalation.post({
      incidentId: INCIDENT,
      ladder: 'outage',
      step: 1,
      where: { kind: 'thread', channel: CHANNEL, threadId: ROOT },
      mention: '@teamsDev',
      text: `Escalating (outage, step 1 of 2): WEB-1042 ${SPOOF}`,
    });
    expect(calls[0]?.body.text).toBe(`<at>teamsDev</at> Escalating (outage, step 1 of 2): WEB-1042 ${SHOWN}`);
    expect(calls[0]?.body.entities).toEqual([DEV_ENTITY]);
  });

  it('a digest line posts to a channel and to a person with no mention entity', async () => {
    const text = renderDigest({
      window: { from: new Date(T0 - 86_400_000), to: new Date(T0) },
      opened: 1,
      closed: 0,
      pullRequests: 0,
      autopilotMerges: 0,
      reverts: 0,
      oldestOpen: [{ incidentId: INCIDENT, label: 'WEB-1042', summary: SPOOF, openedAt: new Date(T0 - 3_600_000).toISOString(), ageMs: 3_600_000, waitingOn: 'human' }],
    });
    await router.postTo('#web-bugs-teams', text);
    await router.postTo('@teamsDev', text);
    const posts = calls.filter((c) => c.path.endsWith('/activities'));
    expect(posts.map((c) => c.path)).toEqual([`conversations/${CHANNEL}/activities`, `conversations/${PERSONAL}-5c1d/activities`]);
    for (const p of posts) {
      expect(p.body.text).toContain(`- WEB-1042, ${SHOWN}: open 1h, waiting on an engineer.`);
      expect(p.body.text).not.toContain('<at>');
      expect(p.body.entities).toBeUndefined();
    }
  });

  it('a ux friction task summary posts to the bug channel with no mention entity', async () => {
    await router.channelPost('#web-bugs-teams', `${SPOOF}. When several people hit the same thing, the product is inviting it: filed a WEB Task labeled ux-friction.`);
    expect(calls[0]?.body.text).toBe(`${SHOWN}. When several people hit the same thing, the product is inviting it: filed a WEB Task labeled ux-friction.`);
    expect(calls[0]?.body.entities).toBeUndefined();
  });

  it('a thread post mentions the person it addresses, never one the text it carries names', async () => {
    await router.threadPost(INCIDENT, { text: `@teamsDev, still on it? ${SPOOF}`, mentionUserId: DEV_AAD });
    expect(calls[0]?.body.text).toBe(`<at>teamsDev</at>, still on it? ${SHOWN}`);
    expect(calls[0]?.body.entities).toEqual([DEV_ENTITY]);
  });

  it('a string shaped like a mark in user text is not one', async () => {
    await surface.channelPost(CHANNEL, `\u0002${REVIEWER_AAD}\u0003 and \u0002teamsReviewer\u0003`);
    expect(calls[0]?.body.text).not.toContain('<at>');
    expect(calls[0]?.body.entities).toBeUndefined();
  });
});

describe('the PR card and the GitHub link prompt', () => {
  it('posts the card in the thread with Merge for a viewer who can, and records it as role pr', async () => {
    await surface.prReady.postPrReady({ channel: CHANNEL, threadId: ROOT }, INCIDENT, prCard, { canMerge: true });
    expect(calls[0]?.path).toBe(`conversations/${CHANNEL};messageid=${ROOT}/activities/${ROOT}`);
    const card = cardOf(calls[0] as Call);
    expect(card.actions?.map((a) => a.title)).toEqual(['Open PR', 'Merge', 'Request changes', 'Stop']);
    expect(card.body[0]?.text).toContain('PR #418 is ready');
    expect(card.body[0]?.text).toContain('<at>teamsDev</at>');
    expect(card.msteams?.entities.map((e) => e.mentioned.id)).toEqual([DEV_AAD]);
    expect(botRecords(await state.read(INCIDENT))).toEqual([{ platform: 'teams', channel: CHANNEL, messageId: POSTED, role: 'pr' }]);
  });

  it('offers Open PR only when the viewer cannot merge', async () => {
    await surface.prReady.postPrReady({ channel: CHANNEL, threadId: ROOT }, INCIDENT, prCard, { canMerge: false });
    expect(cardOf(calls[0] as Call).actions?.map((a) => a.title)).toEqual(['Open PR']);
  });

  it('drops the thread in a personal chat', async () => {
    await surface.prReady.postPrReady({ channel: PERSONAL, threadId: '1790000000009' }, DM_INCIDENT, prCard, { canMerge: false });
    expect(calls[0]?.path).toBe(`conversations/${PERSONAL}/activities`);
  });

  it('banners every card in a team in reduced mode', async () => {
    await writeTeamsMode(createKvCache(state as unknown as StateStore), TEAM, 'reduced');
    await surface.prReady.postPrReady({ channel: CHANNEL, threadId: ROOT }, INCIDENT, prCard, { canMerge: false });
    expect(cardOf(calls[0] as Call).body[0]?.text).toContain('Reduced mode');
  });

  it('sends the link prompt to the reviewer personal chat, Open PR only, with the link as a button', async () => {
    await surface.prReady.postLinkPrompt(REVIEWER_AAD, { channel: CHANNEL, threadId: ROOT }, INCIDENT, prCard, 'https://snapwing.test/auth/github/start?state=abc');
    expect(calls.map((c) => c.path)).toEqual(['conversations', `conversations/${PERSONAL}-6e2f/activities`]);
    const card = cardOf(calls[1] as Call);
    expect(card.actions?.map((a) => [a.type, a.title])).toEqual([
      ['Action.OpenUrl', 'Open PR'],
      ['Action.OpenUrl', 'Link your GitHub account'],
    ]);
    expect(card.actions?.[1]?.url).toBe('https://snapwing.test/auth/github/start?state=abc');
    expect(botRecords(await state.read(INCIDENT))).toEqual([]);
  });

  it('a reviewer without a personal install gets a thread mention, never the link', async () => {
    await surface.prReady.postLinkPrompt(NOINSTALL_AAD, { channel: CHANNEL, threadId: ROOT }, INCIDENT, prCard, 'https://snapwing.test/auth/github/start?state=secret-state');
    expect(calls.map((c) => c.path)).toEqual(['conversations', `conversations/${CHANNEL};messageid=${ROOT}/activities/${ROOT}`]);
    const posted = calls[1]?.body;
    expect(posted.text).toContain('<at>noInstall</at>');
    expect(posted.text).toContain("can't message you directly");
    expect(JSON.stringify(posted)).not.toContain('secret-state');
    expect(posted.entities).toEqual([{ type: 'mention', text: '<at>noInstall</at>', mentioned: { id: NOINSTALL_AAD, name: 'noInstall' } }]);
  });

  it('checks the GitHub link through the identity store as a Teams user', async () => {
    linked.add(DEV_AAD);
    expect(await surface.githubLinked(DEV_AAD)).toBe(true);
    expect(await surface.githubLinked(REVIEWER_AAD)).toBe(false);
  });
});

describe('text-signal cards (A 3)', () => {
  const prompt = {
    userId: DEV_AAD,
    issueKey: 'WEB-1042',
    resolution: 'cannot-reproduce',
    messageId: '1790000400001',
    text: 'Close WEB-1042 as Cannot Reproduce?',
    choices: ['close', 'keep-open'],
  } as const;

  it('asks the resolution question in the asker personal chat', async () => {
    await surface.textCards.askResolution(INCIDENT, prompt as never);
    expect(calls.map((c) => c.path)).toEqual(['conversations', `conversations/${PERSONAL}-5c1d/activities`]);
    const card = cardOf(calls[1] as Call);
    expect(card.body[0]?.text).toBe('Close WEB-1042 as Cannot Reproduce?');
    expect(card.actions?.map((a) => [a.verb, a.data])).toEqual([
      ['close', { incidentId: INCIDENT, messageId: '1790000400001' }],
      ['keep-open', { incidentId: INCIDENT, messageId: '1790000400001' }],
    ]);
  });

  it('asks in the thread with a mention when the asker has no personal install', async () => {
    await surface.textCards.askResolution(INCIDENT, { ...prompt, userId: NOINSTALL_AAD } as never);
    expect(calls.map((c) => c.path)).toEqual(['conversations', `conversations/${CHANNEL};messageid=${ROOT}/activities/${ROOT}`]);
    const card = cardOf(calls[1] as Call);
    expect(card.body[0]?.text).toContain('<at>noInstall</at>');
    expect(card.body[1]?.text).toBe('Close WEB-1042 as Cannot Reproduce?');
    expect(card.msteams?.entities.map((e) => e.mentioned.id)).toEqual([NOINSTALL_AAD]);
  });

  it('posts the scope-change card in the thread and returns it as a role other message', async () => {
    const posted = await surface.textCards.postScopeCard(INCIDENT, {
      kind: 'scope-change',
      text: 'Sounds like a second issue on the app. File it separately?',
      messageId: '1790000400002',
      choices: [
        { id: 'yes', label: 'Yes' },
        { id: 'same', label: "It's the same bug" },
      ],
    } as never);
    expect(calls[0]?.path).toBe(`conversations/${CHANNEL};messageid=${ROOT}/activities/${ROOT}`);
    expect(cardOf(calls[0] as Call).actions?.map((a) => a.verb)).toEqual(['yes', 'same']);
    expect(posted).toEqual({ platform: 'teams', channel: CHANNEL, messageId: POSTED, role: 'other' });
  });

  it('puts the scope and resolution cards under the captured thread root when the reported message is a reply', async () => {
    const REPLY_INCIDENT = '01K6TEAMSCHAT00000000000003';
    const REPLY = '1790000100777';
    await seed(REPLY_INCIDENT, { channelId: CHANNEL, anchorId: REPLY, threadId: ROOT });
    await surface.textCards.postScopeCard(REPLY_INCIDENT, { kind: 'scope-change', text: 'x', messageId: 'm', choices: [{ id: 'yes', label: 'Yes' }] } as never);
    await surface.textCards.askResolution(REPLY_INCIDENT, { ...prompt, userId: NOINSTALL_AAD } as never);
    const thread = `conversations/${CHANNEL};messageid=${ROOT}/activities/${ROOT}`;
    expect(calls.map((c) => c.path)).toEqual([thread, 'conversations', thread]);
  });

  it('treats an id the map lists as a Teams channel as a channel, whatever its suffix, when no record exists', async () => {
    const OLD = '19:legacy0123456789@thread.skype';
    const legacy = { ...map, channels: [...map.channels, { id: OLD, name: 'legacy', platform: 'teams', teamId: TEAM } as never] };
    const s = createTeamsChatSurface({
      connector: createTeamsConnector({ token: async () => 'teams-test-token' }),
      graph: createTeamsGraph({ token: 'graph-test-token' }),
      state,
      cache: createKvCache(state as unknown as StateStore),
      getMap: () => Promise.resolve(legacy),
      identity: { isLinked: () => Promise.resolve(false) },
      serviceUrl: SERVICE_URL,
      log: { info: (l) => logs.push(l), error: (l) => errors.push(l) },
    });
    await s.threadPost({ channel: OLD, threadId: ROOT }, 'hi');
    expect(calls[0]?.path).toBe(`conversations/${OLD};messageid=${ROOT}/activities/${ROOT}`);
  });

  it('posts nothing for an incident that has no Teams thread', async () => {
    const posted = await surface.textCards.postScopeCard('01K6NOSUCHINCIDENT0000000000', { kind: 'scope-change', text: 'x', messageId: 'm', choices: [{ id: 'yes', label: 'Yes' }] } as never);
    expect(posted).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe('the mid-flight card (A 2.2)', () => {
  it('posts in the thread with the run and claimer on each tap, and the router records role other', async () => {
    await router.postMidFlightCard(INCIDENT, midFlight);
    expect(calls[0]?.path).toBe(`conversations/${CHANNEL};messageid=${ROOT}/activities/${ROOT}`);
    const card = cardOf(calls[0] as Call);
    expect(card.actions?.map((a) => [a.title, a.verb, a.data])).toEqual([
      ['Let it finish', 'let_it_finish', { incidentId: INCIDENT, runId: midFlight.runId, claimerId: DEV_AAD }],
      ["Stop it, I'll take over", 'stop_it', { incidentId: INCIDENT, runId: midFlight.runId, claimerId: DEV_AAD }],
    ]);
    expect(card.body.map((b) => b.text).join('\n')).toContain('No answer in 10 minutes means **Let it finish**.');
    expect(card.msteams?.entities.map((e) => e.mentioned.id)).toEqual([DEV_AAD]);
    expect(botRecords(await state.read(INCIDENT))).toEqual([{ platform: 'teams', channel: CHANNEL, messageId: POSTED, role: 'other' }]);
  });
});

describe('channel members (A 4.4)', () => {
  const members = (...ids: (string | null)[]) => () =>
    HttpResponse.json({ value: ids.map((userId, i) => ({ id: `m${i}`, displayName: `n${i}`, userId, roles: [] })) });

  it('writes kv channel-members for every Teams channel in the map, sorted and de-duplicated, with the 6 h TTL', async () => {
    graphMembers.set(CHANNEL, members(REVIEWER_AAD, DEV_AAD, DEV_AAD, null));
    await surface.refreshChannelMembers();
    const raw = await createKvCache(state as unknown as StateStore).get(channelMembersKey(CHANNEL));
    expect(JSON.parse(raw ?? 'null')).toEqual([DEV_AAD, REVIEWER_AAD].sort());
    expect(CHANNEL_MEMBERS_TTL_SEC).toBe(6 * 60 * 60);
    expect(CHANNEL_MEMBERS_REFRESH_MS).toBe(2 * 60 * 60 * 1000);
    // Slack channels of the map are not Graph's to list.
    expect(await createKvCache(state as unknown as StateStore).get(channelMembersKey('C0WEBBUGS'))).toBeNull();
  });

  it('the notification policy reads the list the surface wrote', async () => {
    graphMembers.set(CHANNEL, members(DEV_AAD));
    const out = await surface.channelMembers.refresh(CHANNEL);
    expect(out).toEqual({ kind: 'refreshed', channel: CHANNEL, members: 1 });
  });

  it('skips a channel without the grant with one info log, never an error, and keeps the key unwritten', async () => {
    graphMembers.set(CHANNEL, () => HttpResponse.json({ error: { code: 'Forbidden', message: 'Insufficient privileges' } }, { status: 403 }));
    await surface.refreshChannelMembers();
    await surface.refreshChannelMembers();
    expect(await createKvCache(state as unknown as StateStore).get(channelMembersKey(CHANNEL))).toBeNull();
    expect(logs.filter((l) => l.includes('channel members of') && l.includes('missing-grant'))).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('skips a channel that no longer exists the same way', async () => {
    await surface.refreshChannelMembers();
    expect(logs.some((l) => l.includes(CHANNEL) && l.includes('not-found'))).toBe(true);
    expect(errors).toEqual([]);
    expect(await createKvCache(state as unknown as StateStore).get(channelMembersKey(CHANNEL))).toBeNull();
  });

  it('reports any other Graph failure as an error and carries on', async () => {
    graphMembers.set(CHANNEL, () => HttpResponse.json({ error: { code: 'InternalServerError', message: 'boom' } }, { status: 500 }));
    await surface.refreshChannelMembers();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('channel members');
    errors.length = 0;
  });
});
