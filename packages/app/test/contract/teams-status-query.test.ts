// Status pull in Teams (#9; A 4.3, A 4.4, main 15.2): a mention in a thread, a mention anywhere, the
// personal chat, and the `status` command, each answered in place through `respond`, shaped to the
// asker's role from the map (`teamsId`), over a real store on the dialect `SNAPWING_DB` selects. The Bot
// Connector is MSW; standing watches write and remove real subscription rows.

import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { EventPayloads, EventType, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import { parseWorkspaceMap } from '@snapwing/pipeline/map/parse.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { createKvCache } from '@snapwing/pipeline/providers/local/cache.ts';
import type { StateStore } from '@snapwing/pipeline/state/store.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { createTeamsConnector } from '../../src/adapters/teams/connector.ts';
import { teamsUserKey } from '../../src/adapters/teams/conversations.ts';
import { createTeamsStatusQuery, type TeamsStatusQuery } from '../../src/adapters/teams/status-query.ts';

const exampleXml = readFileSync(new URL('../../../../examples/workspace-context.example.xml', import.meta.url), 'utf8');

const T0 = Date.parse('2026-10-02T14:40:00.000Z');
const WS = '01K6WORKSPACE0000000000000';
const SERVICE_URL = 'https://smba.test/amer/';
const V3 = 'https://smba.test/amer/v3';
const BOT = '28:bot-app-id';
const CHANNEL = '19:5f3c0a7e9d2b4c1a8e6f@thread.tacv2';
const OTHER_CHANNEL = '19:9a8b7c6d5e4f3a2b1c0d@thread.tacv2';
const PERSONAL = '19:4b1f6a52_personal@unq.gbl.spaces';
const ENGINEER = '4b1f6a52-8c3d-4e07-9a1b-2d5f7c9e0a13';
const REPORTER = '7c2e9d10-1a4b-4f6e-8b3d-5e0a9c7f2b41';
const STRANGER = '0d9e8f77-6c5b-4a39-8e21-1f0a3b5c7d9e';
const NAV = { id: '01K6TEAMSQ00000000000000001', key: 'WEB-1042', anchor: '1790000000001' };
const CART_A = { id: '01K6TEAMSQ00000000000000002', key: 'WEB-1051', anchor: '1790000000002' };
const CART_B = { id: '01K6TEAMSQ00000000000000003', key: 'WEB-1060', anchor: '1790000000003' };
type Seed = { id: string; key: string; anchor: string };

let map: WorkspaceMap;
beforeAll(async () => {
  const parsed = await parseWorkspaceMap(exampleXml);
  const aad: Record<string, string> = { U0WEBDEV1: ENGINEER, U0SALESLEAD: REPORTER };
  map = {
    ...parsed,
    people: parsed.people.map((p) => (p.slackId !== undefined && aad[p.slackId] !== undefined ? { ...p, teamsId: aad[p.slackId] as string } : p)),
    surfaces: [{ id: 'web', label: 'Website', repo: 'acme/web', jira: { project: 'WEB', defaultIssueType: 'Bug' }, components: parsed.surfaces[0]?.components ?? [] }],
  };
});

const server = setupServer();
beforeAll(() => server.listen());
afterAll(() => server.close());

interface Sent {
  /** The conversation path the connector posted to (a thread reply is `<channel>;messageid=<root>`). */
  conversationId: string;
  /** Set for a reply (`/activities/{id}`), absent for a plain send. */
  replyTo?: string;
  body: { type: string; text?: string; attachments?: { contentType: string; content: { fallbackText: string; body: { text: string }[]; actions?: { verb: string }[]; msteams?: { entities?: unknown[] } } }[] };
}

let tdb: TestDatabase;
let state: OpenedState;
let sent: Sent[];
let errors: unknown[];
let teams: TeamsStatusQuery;

beforeEach(async () => {
  tdb = await createTestDatabase();
  state = await tdb.open({ now: () => new Date(T0) });
  sent = [];
  errors = [];
  server.use(
    http.post(`${V3}/conversations/:id/activities/:activity`, async ({ request, params }) => {
      sent.push({ conversationId: decodeURIComponent(String(params['id'])), replyTo: String(params['activity']), body: (await request.json()) as Sent['body'] });
      return HttpResponse.json({ id: '1790000300001' });
    }),
    http.post(`${V3}/conversations/:id/activities`, async ({ request, params }) => {
      sent.push({ conversationId: decodeURIComponent(String(params['id'])), body: (await request.json()) as Sent['body'] });
      return HttpResponse.json({ id: '1790000300002' });
    }),
  );
  teams = createTeamsStatusQuery({
    connector: createTeamsConnector({ token: async () => 'teams-test-token', botId: BOT }),
    state,
    standing: state,
    workspaceId: WS,
    getMap: () => Promise.resolve(map),
    clock: () => new Date(T0),
    onError: (e) => errors.push(e),
  });
});

afterEach(async () => {
  server.resetHandlers();
  expect(errors).toEqual([]);
  await tdb.drop();
});

// Log ---------------------------------------------------------------------------------------------

function ev<T extends EventType>(id: string, type: T, payload: EventPayloads[T]): NewEvent<T> {
  return { workspaceId: WS, incidentId: id, type, v: 1, source: 'agent', occurredAt: new Date(T0 - 600_000).toISOString(), payload } as unknown as NewEvent<T>;
}

/** Filed on web/`component` with the fixer running; `threadId` is the channel thread the anchor was a reply in. */
async function seed(inc: Seed, summary: string, component: string, opts: { channel?: string; threadId?: string } = {}): Promise<void> {
  await state.append(
    inc.id,
    [
      ev(inc.id, 'captured', {
        kind: 'incident',
        idempotencyKey: `teams-${inc.anchor}-bug`,
        source: 'teams',
        reporter: { id: REPORTER, name: 'salesLead', role: 'reporter' },
        anchorText: summary,
        anchorId: inc.anchor,
        channelId: opts.channel ?? CHANNEL,
        ...(opts.threadId === undefined ? {} : { threadId: opts.threadId }),
        rawPayloadSnapshot: { type: 'reaction', reaction: 'bug', anchorId: inc.anchor },
      }),
      ev(inc.id, 'context-assembled', { bundle: { artifactId: '01K6BUNDLE00000000000000001', version: 1 }, includedCount: 1, excludedCount: 0 }),
      ev(inc.id, 'resolved', { surfaceId: 'web', componentId: component, repo: 'github.com/acme/web', resolvedBy: 'channel-explicit', confidence: 0.9 }),
      ev(inc.id, 'dedupe-checked', { candidates: [], decision: 'none' }),
      ev(inc.id, 'planned', {
        action: 'create_issue',
        projectKey: 'WEB',
        issueType: 'Bug',
        summary,
        priority: 'High',
        labels: ['snapwing'],
        autonomyLevel: 2,
        implementationRequest: { artifactId: '01K6REQUEST000000000000001', version: 1 },
      }),
      ev(inc.id, 'filed', { jiraKey: inc.key }),
      ev(inc.id, 'fixer-started', { runId: 'run-1', harness: 'claude-code', attempt: 1 }),
    ],
    0,
  );
}

// Activities --------------------------------------------------------------------------------------

let n = 0;

interface Opts {
  id?: string;
  /** Channel messages: the thread root the conversation id carries and the `replyToId` of a reply. */
  root?: string;
  channel?: string;
  from?: Record<string, unknown>;
}

function person(aad: string): Record<string, unknown> {
  return { id: `29:${aad.slice(0, 8)}`, aadObjectId: aad, name: 'Someone' };
}

/** A channel message that mentions the bot: top-level (the conversation id carries its own id) or a thread reply. */
function mention(aad: string, text: string, opts: Opts = {}): Record<string, unknown> {
  n += 1;
  const id = opts.id ?? `17900001${String(n).padStart(5, '0')}`;
  const channel = opts.channel ?? CHANNEL;
  return {
    type: 'message',
    id,
    serviceUrl: SERVICE_URL,
    channelId: 'msteams',
    from: opts.from ?? person(aad),
    recipient: { id: BOT, name: 'Snapwing' },
    conversation: { id: `${channel};messageid=${opts.root ?? id}`, conversationType: 'channel', isGroup: true, tenantId: 'tenant-1' },
    channelData: { channel: { id: channel }, team: { aadGroupId: 'team-1' }, tenant: { id: 'tenant-1' } },
    ...(opts.root === undefined ? {} : { replyToId: opts.root }),
    text: `<at>Snapwing</at> ${text}`,
    textFormat: 'xml',
    entities: [{ type: 'mention', text: '<at>Snapwing</at>', mentioned: { id: BOT, name: 'Snapwing' } }],
  };
}

function chat(aad: string, text: string, opts: Opts = {}): Record<string, unknown> {
  n += 1;
  return {
    type: 'message',
    id: opts.id ?? `17900002${String(n).padStart(5, '0')}`,
    serviceUrl: SERVICE_URL,
    channelId: 'msteams',
    from: opts.from ?? person(aad),
    recipient: { id: BOT, name: 'Snapwing' },
    conversation: { id: PERSONAL, conversationType: 'personal', tenantId: 'tenant-1' },
    text,
  };
}

/** What a person reads in an answer: the text of its card. */
function cardText(message: Sent | undefined): string {
  return (message?.body.attachments ?? []).flatMap((a) => a.content.body.map((b) => b.text)).join('\n');
}

async function answerTo(activity: Record<string, unknown>): Promise<string> {
  expect(teams.intercepts(activity)).toBe(true);
  await teams.handle(activity);
  expect(sent).toHaveLength(1);
  return cardText(sent[0]);
}

// Entry points ------------------------------------------------------------------------------------

describe('a mention in a thread', () => {
  it('answers in that thread for the thread incident', async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    await seed(CART_A, 'Cart total blank', 'checkout');
    const text = await answerTo(mention(REPORTER, 'where are we with this?', { root: NAV.anchor }));
    expect(sent[0]).toMatchObject({ conversationId: `${CHANNEL};messageid=${NAV.anchor}` });
    expect(text).toContain('WEB-1042');
    expect(text).not.toContain('WEB-1051');
    expect(text).not.toMatch(/\bPR\b/);
    expect(sent[0]?.body.attachments).toHaveLength(1);
  });

  it('finds the incident through captured.threadId, which lives only in the log', async () => {
    const parent = '1790000000050';
    await seed(NAV, 'Nav menu missing on pricing page', 'nav', { threadId: parent });
    await seed(CART_A, 'Cart total blank', 'checkout');
    const text = await answerTo(mention(REPORTER, 'where are we with this?', { root: parent }));
    expect(text).toContain('WEB-1042');
    expect(sent[0]).toMatchObject({ conversationId: `${CHANNEL};messageid=${parent}` });
  });

  it('shapes the answer to the asker: engineer, reporter, and a stranger get three shapes', async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    const as = async (aad: string) => {
      sent.length = 0;
      await teams.handle(mention(aad, 'WEB-1042'));
      return cardText(sent[0]);
    };
    const engineer = await as(ENGINEER);
    const reporter = await as(REPORTER);
    const lead = await as(STRANGER);
    expect(new Set([engineer, reporter, lead]).size).toBe(3);
    expect(engineer).toContain('High');
    expect(reporter).not.toContain('High');
    expect(lead).toContain('High');
  });

  it('gives an engineer the Stop button the interactivity owns, and nobody else', async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    await answerTo(mention(ENGINEER, 'where are we with this?', { root: NAV.anchor }));
    expect(sent[0]?.body.attachments?.[0]?.content.actions?.map((a) => a.verb)).toContain('stop');
    sent.length = 0;
    await answerTo(mention(REPORTER, 'where are we with this?', { root: NAV.anchor }));
    expect(sent[0]?.body.attachments?.[0]?.content.actions).toBeUndefined();
  });

  it('names a person outside the map as Teams names them, never by their raw id', async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    const last = (await state.read(NAV.id)).at(-1)?.seq ?? 0;
    await state.append(NAV.id, [{ ...ev(NAV.id, 'claimed', { claimerId: STRANGER, expiresAt: new Date(T0 + 3_600_000).toISOString() }), actor: { id: STRANGER, role: 'unknown' } }], last);
    const cache = createKvCache(state as unknown as StateStore);
    await cache.set(teamsUserKey(STRANGER), JSON.stringify({ aadObjectId: STRANGER, name: 'Stranger Danger', serviceUrl: SERVICE_URL, updatedAt: new Date(T0).toISOString() }));
    teams = createTeamsStatusQuery({
      connector: createTeamsConnector({ token: async () => 'teams-test-token', botId: BOT }),
      state,
      workspaceId: WS,
      getMap: () => Promise.resolve(map),
      cache,
      clock: () => new Date(T0),
      onError: (e) => errors.push(e),
    });
    const answer = await answerTo(mention(ENGINEER, 'where are we with this?', { root: NAV.anchor }));
    expect(answer).toContain('claimed by <at>Stranger Danger</at>');
    expect(answer).not.toContain(STRANGER);
    expect(sent[0]?.body.attachments?.[0]?.content.msteams?.entities).toContainEqual({ type: 'mention', text: '<at>Stranger Danger</at>', mentioned: { id: STRANGER, name: 'Stranger Danger' } });
  });
});

describe('a mention anywhere', () => {
  it('matches the words against open incidents and answers under the mention', async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    await seed(CART_A, 'Cart total blank', 'checkout', { channel: OTHER_CHANNEL });
    const text = await answerTo(mention(REPORTER, 'status on the cart total', { id: '1790000400001', channel: '19:general@thread.tacv2' }));
    expect(text).toContain('WEB-1051');
    // The mention's own message starts the thread the answer goes in.
    expect(sent[0]).toMatchObject({ conversationId: '19:general@thread.tacv2;messageid=1790000400001', replyTo: '1790000400001' });
  });

  it('takes an explicit key', async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    await seed(CART_A, 'Cart total blank', 'checkout');
    expect(await answerTo(mention(ENGINEER, 'WEB-1042'))).toContain('WEB-1042');
  });

  it('asks which one when two candidates tie, naming both', async () => {
    await seed(CART_A, 'Cart total blank', 'checkout');
    await seed(CART_B, 'Cart total wrong', 'checkout');
    const text = await answerTo(mention(REPORTER, 'status on the cart total'));
    expect(text).toContain('WEB-1051');
    expect(text).toContain('WEB-1060');
    expect(text).toContain('?');
  });

  it('leaves a bot command and any non-status mention to the routes after it', () => {
    expect(teams.intercepts(mention(REPORTER, 'queue'))).toBe(false);
    expect(teams.intercepts(mention(REPORTER, "I'll take this", { root: NAV.anchor }))).toBe(false);
    expect(teams.intercepts(mention(REPORTER, ''))).toBe(false);
    expect(teams.intercepts(mention(REPORTER, 'status on the cart total'))).toBe(true);
  });

  it('shows the answer once, as a card, and keeps a summary link inert', async () => {
    await seed(NAV, 'Broken [Reset password](https://evil.example) link', 'nav');
    await teams.handle(mention(REPORTER, 'WEB-1042'));
    expect(sent).toHaveLength(1);
    const activity = sent[0]?.body;
    expect(activity?.text).toBeUndefined();
    expect(activity?.attachments).toHaveLength(1);
    const json = JSON.stringify(activity);
    expect(json).toContain('Reset password');
    expect(json).not.toContain('[Reset password](https://evil.example)');
  });

  it('ignores a channel message that does not name the bot', () => {
    const quiet = mention(REPORTER, 'status') as { entities?: unknown };
    delete quiet.entities;
    expect(teams.intercepts(quiet)).toBe(false);
  });

  it('answers a group chat mention in the chat', async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    const activity = { ...mention(REPORTER, 'WEB-1042', { id: '1790000500001' }), conversation: { id: '19:group@thread.v2', conversationType: 'groupChat', tenantId: 'tenant-1' } };
    expect(await answerTo(activity)).toContain('WEB-1042');
    expect(sent[0]).toMatchObject({ conversationId: '19:group@thread.v2', replyTo: '1790000500001' });
  });
});

describe('only people count', () => {
  it("ignores Snapwing's own message, another bot, and a message with no AAD user", async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    const own = mention(REPORTER, 'status', { from: { id: BOT, name: 'Snapwing' } });
    const otherBot = mention(REPORTER, 'status', { from: { id: '28:other-bot', aadObjectId: STRANGER, name: 'Other', role: 'bot' } });
    const noUser = mention(REPORTER, 'status', { from: { id: '29:abc', name: 'Webhook' } });
    const botChat = chat(REPORTER, "what's open on the website?", { from: { id: '28:other-bot', aadObjectId: STRANGER, name: 'Other', role: 'bot' } });
    for (const activity of [own, otherBot, noUser, botChat]) {
      expect(teams.intercepts(activity)).toBe(false);
      await teams.handle(activity);
    }
    expect(sent).toEqual([]);
  });

  it('does not answer an activity that is not a message', () => {
    expect(teams.intercepts({ ...mention(REPORTER, 'status'), type: 'messageReaction' })).toBe(false);
  });
});

describe('the personal chat', () => {
  it('answers a status question in the chat, with no thread', async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    await seed(CART_A, 'Cart total blank', 'checkout');
    const text = await answerTo(chat(STRANGER, "what's open on the website?"));
    expect(sent[0]).toMatchObject({ conversationId: PERSONAL });
    expect(sent[0]?.replyTo).toBeUndefined();
    expect(text).toContain('WEB-1042');
    expect(text).toContain('WEB-1051');
  });

  it('answers a bare key in the chat', async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    await seed(CART_A, 'Cart total blank', 'checkout');
    const text = await answerTo(chat(ENGINEER, 'WEB-1051?'));
    expect(text).toContain('WEB-1051');
    expect(text).not.toContain('WEB-1042');
    expect(sent[0]).toMatchObject({ conversationId: PERSONAL });
  });

  it('leaves any other message alone so it is captured', () => {
    expect(teams.intercepts(chat(REPORTER, 'the nav menu is gone on safari, status page too'))).toBe(false);
    expect(teams.intercepts(chat(REPORTER, 'checkout is broken'))).toBe(false);
    expect(teams.intercepts(chat(REPORTER, 'the statuses are wrong'))).toBe(false);
  });
});

describe('the status command', () => {
  it('answers in the personal chat for the words or key given', async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    await seed(CART_A, 'Cart total blank', 'checkout');
    const text = await answerTo(chat(ENGINEER, 'status WEB-1051'));
    expect(sent[0]).toMatchObject({ conversationId: PERSONAL });
    expect(text).toContain('WEB-1051');
    expect(text).not.toContain('WEB-1042');
  });

  it('with no words, lists the open incidents on the surface', async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    await seed(CART_A, 'Cart total blank', 'checkout');
    const text = await answerTo(chat(STRANGER, 'Status'));
    expect(text).toContain('WEB-1042');
    expect(text).toContain('WEB-1051');
  });

  it('is only a command to the bot: an unaddressed channel message is not one', () => {
    const channelMessage = { ...mention(REPORTER, 'status WEB-1042'), entities: [], text: 'status WEB-1042' };
    expect(teams.intercepts(channelMessage)).toBe(false);
  });
});

describe('standing watches (A 4.4)', () => {
  it('"keep me posted on the website" writes a surface row and confirms in the chat; "stop updating me on web" removes it', async () => {
    const watch = chat(REPORTER, 'keep me posted on the website');
    expect(teams.intercepts(watch)).toBe(true);
    await teams.handle(watch);
    expect(sent.map((s) => [s.conversationId, s.body.text])).toEqual([[PERSONAL, 'Done. I will keep you posted on every incident on Website.']]);

    // A new incident on `web` sees it: getSubscriptions covers the incident's surface.
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    expect((await state.getSubscriptions(NAV.id)).map((s) => [s.userId, s.scopeKind, s.scopeId, s.channel, s.platform])).toEqual([[REPORTER, 'surface', 'web', 'dm', 'teams']]);

    sent.length = 0;
    await teams.handle(chat(REPORTER, 'stop updating me on web'));
    expect(sent.map((s) => [s.conversationId, s.body.text])).toEqual([[PERSONAL, 'Okay, I will stop updating you on every incident on Website.']]);
    expect((await state.getSubscriptions(NAV.id)).filter((s) => s.userId === REPORTER)).toEqual([]);
  });

  it('the shared parser takes "stop updating me", also unanchored, with no Teams-local rewrite', async () => {
    await teams.handle(chat(REPORTER, 'keep me posted on the website'));
    sent.length = 0;
    await teams.handle(chat(REPORTER, 'can you stop updating me on web'));
    expect(sent.map((s) => s.body.text)).toEqual(['Okay, I will stop updating you on every incident on Website.']);
  });

  it('a personal-chat "status ..." report is captured, not answered; "status" with a key, "?" or "of/on/for" is a question', () => {
    expect(teams.intercepts(chat(REPORTER, 'status page is down after deploy'))).toBe(false);
    expect(teams.intercepts(chat(REPORTER, 'status code 500 on checkout'))).toBe(false);
    for (const q of ['status', 'status?', 'status on WEB-1042', 'status of the cart bug']) expect(teams.intercepts(chat(REPORTER, q)), q).toBe(true);
  });

  it('"status web" and "status Web?" are answered (a surface after status); "status web page is down" is captured', async () => {
    await teams.handle(chat(REPORTER, 'status web'));
    expect(sent).toHaveLength(1);
    expect(teams.intercepts(chat(REPORTER, 'status Web?'))).toBe(true);
    expect(teams.intercepts(chat(REPORTER, 'status web page is down'))).toBe(false);
  });

  it('asks which surface is meant when the target is unknown, and writes nothing', async () => {
    await teams.handle(chat(REPORTER, 'keep me posted on the moon'));
    expect(sent[0]?.body.text).toContain('could not tell which surface');
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    expect(await state.getSubscriptions(NAV.id)).toEqual([]);
  });

  it('is not intercepted without a place to write it', () => {
    const readOnly = createTeamsStatusQuery({
      connector: createTeamsConnector({ token: async () => 'teams-test-token', botId: BOT }),
      state,
      workspaceId: WS,
      getMap: () => Promise.resolve(map),
    });
    expect(readOnly.intercepts(chat(REPORTER, 'keep me posted on the website'))).toBe(false);
  });
});

describe('speed and redelivery', () => {
  it('answers over thirty open incidents in under a second', async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    for (let i = 0; i < 30; i += 1) {
      const k = String(i).padStart(2, '0');
      await seed({ id: `01K6TEAMSQ0000000000001${k}0`.slice(0, 26), key: `WEB-${2000 + i}`, anchor: `17899000000${k}` }, `Filler report ${i}`, 'nav');
    }
    const started = Date.now();
    const text = await answerTo(mention(ENGINEER, 'where are we with this?', { root: NAV.anchor }));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(text).toContain('WEB-1042');
  });

  it('answers a redelivered activity once', async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    const activity = chat(REPORTER, 'WEB-1042');
    await teams.handle(activity);
    await teams.handle(activity);
    expect(sent).toHaveLength(1);
  });
});

describe('unlink github in the personal chat (main 11.2)', () => {
  function withIdentity(result: { linked: boolean; revoked: boolean }): unknown[] {
    const calls: unknown[] = [];
    teams = createTeamsStatusQuery({
      connector: createTeamsConnector({ token: async () => 'teams-test-token', botId: BOT }),
      state,
      workspaceId: WS,
      getMap: () => Promise.resolve(map),
      clock: () => new Date(T0),
      identity: {
        disconnect: (user) => {
          calls.push(user);
          return Promise.resolve(result);
        },
      },
      onError: (e) => errors.push(e),
    });
    return calls;
  }

  it('unlinks the asker, and answers in the chat', async () => {
    const calls = withIdentity({ linked: true, revoked: true });
    const ask = chat(REPORTER, 'unlink github');
    expect(teams.intercepts(ask)).toBe(true);
    await teams.handle(ask);
    expect(calls).toEqual([{ chat: 'teams', userId: REPORTER }]);
    expect(sent.map((s) => [s.conversationId, s.body.text])).toEqual([[PERSONAL, expect.stringContaining('revoked at GitHub') as unknown]]);
  });

  it('says so when nothing was linked', async () => {
    withIdentity({ linked: false, revoked: true });
    await teams.handle(chat(REPORTER, 'Unlink my GitHub account.'));
    expect(sent[0]?.body.text).toBe('Your GitHub account is not linked.');
  });

  it('leaves a bug report alone, and an install without identity links', () => {
    withIdentity({ linked: true, revoked: true });
    expect(teams.intercepts(chat(REPORTER, 'unlink github button is broken'))).toBe(false);
    const plain = createTeamsStatusQuery({ connector: createTeamsConnector({ token: async () => 'teams-test-token', botId: BOT }), state, workspaceId: WS, getMap: () => Promise.resolve(map) });
    expect(plain.intercepts(chat(REPORTER, 'unlink github'))).toBe(false);
  });
});
