import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { IncidentEvent, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { CanonicalIncidentPayload } from '@snapwing/pipeline/contracts/incident.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { CachePort } from '@snapwing/pipeline/ports/cache.ts';
import {
  ACK_TEXT,
  ADAPTIVE_CARD_CONTENT_TYPE,
  TeamsIgnoredError,
  createTeamsAdapter,
  type TeamsAdapterOptions,
  type TeamsInbound,
  type TeamsJwtVerifier,
} from '../../src/adapters/teams/adapter.ts';
import { REDUCED_BANNER } from '../../src/adapters/teams/cards/elements.ts';
import { createTeamsConnector } from '../../src/adapters/teams/connector.ts';
import { readTeamsConversation, teamsConversationKey, writeTeamsMode } from '../../src/adapters/teams/conversations.ts';
import { createTeamsGraph, type GraphMessage } from '../../src/adapters/teams/graph.ts';

const APP_ID = '00000000-0000-4000-8000-0000000000b0';
const CHANNEL = '19:5f3c0a7e9d2b4c1a8e6f@thread.tacv2';
const TEAM = '2b9e4c7d-0000-4000-8000-0000000000a1';
const TENANT = '7a0d5e6f-0000-4000-8000-0000000000c1';
const RAE = '6f1c2a3b-0000-4000-8000-00000000a001';
const SAM = '6f1c2a3b-0000-4000-8000-00000000e001';
const DM = 'a:1personal-chat-rae';
const ROOT = '1790000100123';
const SERVICE_URL = 'https://smba.test/amer/';
const V3 = 'https://smba.test/amer/v3';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const GOOD = 'Bearer good-test-jwt';
const NOW = new Date('2026-10-03T12:00:00.000Z');
const EVENT_ID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';

function activity(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../fixtures/teams/activities/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
}

const map: WorkspaceMap = {
  org: 'Example',
  updated: '2026-10-03T00:00:00Z',
  surfaces: [],
  channels: [{ id: CHANNEL, name: 'web-bugs', surface: 'web', platform: 'teams', teamId: TEAM, triggerEmoji: [] }],
  triggers: { messageActions: [{ label: 'Fix it from here' }], emoji: [{ slack: 'bug', teams: 'bug' }], directMessage: { images: true, text: true } },
  vocabulary: [],
  people: [
    { teamsId: RAE, handle: 'rae', email: 'rae@example.com', role: 'reporter', owns: [] },
    { teamsId: SAM, handle: 'sam', role: 'engineer', owns: [] },
  ],
  policies: { autonomy: { default: 1, levels: [], overrides: [] } },
};

function memoryCache(): CachePort & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: (k) => Promise.resolve(data.get(k) ?? null),
    set: (k, v) => Promise.resolve(void data.set(k, v)),
    setIfAbsent: (k, v) => {
      if (data.has(k)) return Promise.resolve(false);
      data.set(k, v);
      return Promise.resolve(true);
    },
    delete: (k) => Promise.resolve(void data.delete(k)),
  };
}

interface Seen {
  method: string;
  path: string;
  body: unknown;
}

let seen: Seen[] = [];
let nextId = 0;
let graphUsers = 0;

async function capture(request: Request): Promise<void> {
  const text = await request.text();
  seen.push({ method: request.method, path: decodeURIComponent(new URL(request.url).pathname), body: text === '' ? undefined : (JSON.parse(text) as unknown) });
}

const connectorHandlers = [
  http.post(`${V3}/conversations`, async ({ request }) => {
    await capture(request);
    return HttpResponse.json({ id: 'a:1personal-chat-sam' });
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
  http.get(`${GRAPH}/users/:id`, ({ params }) => {
    graphUsers++;
    const id = String(params['id']);
    if (id === RAE) return HttpResponse.json({ id, displayName: 'Rae Reporter', userPrincipalName: 'rae@contoso.onmicrosoft.com', mail: 'rae@contoso.example' });
    return HttpResponse.json({ id, displayName: 'Sam Engineer', userPrincipalName: 'sam@contoso.onmicrosoft.com', mail: null });
  }),
];

const server = setupServer(...connectorHandlers);
beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  seen = [];
  nextId = 0;
  graphUsers = 0;
});
afterAll(() => server.close());

/** The #369 verifier's shape: a good token for this app and this serviceUrl passes. */
const verify = vi.fn<TeamsJwtVerifier>((authorization, opts) =>
  Promise.resolve({ ok: authorization === GOOD && opts.appId === APP_ID && opts.serviceUrl === SERVICE_URL }),
);

function setup(over: Partial<TeamsAdapterOptions> = {}) {
  const cache = memoryCache();
  const appended: NewEvent[] = [];
  const state = {
    read: () => Promise.resolve([{ workspaceId: 'W0FAKE', seq: 3 }] as unknown as IncidentEvent[]),
    append: (_id: string, events: NewEvent[], seq: number) => {
      appended.push(...events);
      return Promise.resolve({ seq: seq + events.length });
    },
  };
  const onError = vi.fn();
  const adapter = createTeamsAdapter({
    connector: createTeamsConnector({ token: () => Promise.resolve('teams-test-token'), botId: APP_ID }),
    graph: createTeamsGraph({ token: 'graph-test-token' }),
    appId: APP_ID,
    verify,
    cache,
    getMap: () => Promise.resolve(map),
    tenantId: TENANT,
    state,
    onError,
    clock: () => NOW,
    newEventId: () => EVENT_ID,
    ...over,
  });
  return { adapter, cache, appended, onError };
}

const inbound = (a: unknown, authorization = GOOD): TeamsInbound => ({ transport: 'http', headers: new Headers({ authorization }), activity: a });

/** The orchestrator's shape (main 14.1): authenticate, normalize, start the job, acknowledge. */
async function handleInbound(adapter: ReturnType<typeof setup>['adapter'], raw: TeamsInbound) {
  if (!(await adapter.authenticateRequest(raw))) throw new Error('unauthorized');
  const payload = await adapter.normalizePayload(raw);
  return { payload, ack: await adapter.acknowledge(raw, payload) };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

function cardsPosted(): { path: string; card: { body: { text: string }[]; actions?: unknown[] } }[] {
  return seen
    .filter((s) => s.method !== 'GET')
    .flatMap((s) => {
      const attachments = (s.body as { attachments?: { contentType: string; content: unknown }[] } | undefined)?.attachments ?? [];
      return attachments
        .filter((a) => a.contentType === ADAPTIVE_CARD_CONTENT_TYPE)
        .map((a) => ({ path: s.path, card: a.content as { body: { text: string }[]; actions?: unknown[] } }));
    });
}

describe('authenticateRequest', () => {
  it("passes the header, app id, serviceUrl, and channel to the verifier, and refreshes the conversation record", async () => {
    const { adapter, cache } = setup();
    expect(await adapter.authenticateRequest(inbound(activity('action-fetch-task')))).toBe(true);
    expect(verify).toHaveBeenLastCalledWith(GOOD, { appId: APP_ID, serviceUrl: SERVICE_URL, channelId: 'msteams' });
    expect(await readTeamsConversation(cache, CHANNEL)).toEqual({
      serviceUrl: SERVICE_URL,
      tenantId: TENANT,
      teamId: TEAM,
      channelId: CHANNEL,
      conversationType: 'channel',
      threadRootId: ROOT,
      updatedAt: NOW.toISOString(),
    });
  });

  it('a bad token, or an activity with no serviceUrl, is refused and records nothing', async () => {
    const { adapter, cache } = setup();
    expect(await adapter.authenticateRequest(inbound(activity('personal-text'), 'Bearer forged'))).toBe(false);
    const { serviceUrl: _drop, ...noServiceUrl } = activity('personal-text');
    expect(await adapter.authenticateRequest(inbound(noServiceUrl))).toBe(false);
    expect(cache.data.size).toBe(0);
  });

  it('a reaction trigger was authenticated by the Graph notification that carried it', async () => {
    const { adapter } = setup();
    const message = activity('reaction-message') as unknown as GraphMessage;
    expect(await adapter.authenticateRequest({ transport: 'graph', trigger: { teamId: TEAM, channelId: CHANNEL, message, reaction: 'bug', reactorAadId: SAM } })).toBe(true);
  });
});

describe('action command', () => {
  it('is answered with the task message, normalized once, and its cards go in the anchor thread', async () => {
    const { adapter, appended } = setup();
    const raw = inbound(activity('action-fetch-task'));
    const { payload, ack } = await handleInbound(adapter, raw);
    expect(ack).toEqual({ status: 200, body: { task: { type: 'message', value: ACK_TEXT } } });
    expect(await adapter.normalizePayload(raw)).toBe(payload);
    expect(payload.reporter.id).toBe(SAM);
    expect(payload.anchorAuthor?.email).toBe('rae@contoso.example');
    await settle();
    expect(seen).toEqual([]); // no message posted to acknowledge an invoke

    await adapter.postInteractive(payload, { kind: 'scope-preview', summary: 'Checkout total shows NaN' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe(`/amer/v3/conversations/${CHANNEL};messageid=${ROOT}/activities/${ROOT}`);
    const [posted] = cardsPosted();
    expect(posted?.card.body.map((b) => b.text)).toEqual(['Checkout total shows NaN']);
    expect(appended.map((e) => [e.type, e.source, e.payload])).toEqual([
      ['bot-message-posted', 'teams', { platform: 'teams', channel: CHANNEL, messageId: '1790000900001', role: 'scope-preview' }],
    ]);
  });

  it('Graph lookups are cached per person', async () => {
    const { adapter } = setup();
    await handleInbound(adapter, inbound(activity('action-fetch-task')));
    await handleInbound(adapter, inbound(activity('action-submit-reply')));
    expect(graphUsers).toBe(2); // Sam and Rae once each
  });
});

describe('personal chat', () => {
  it('a DM text: "On it" in the personal chat, and cards follow in the chat, not a thread', async () => {
    const { adapter, appended } = setup();
    const { payload, ack } = await handleInbound(adapter, inbound(activity('personal-text')));
    expect(ack).toEqual({ status: 200 });
    await settle();
    expect(seen).toEqual([{ method: 'POST', path: `/amer/v3/conversations/${DM}/activities`, body: { type: 'message', text: ACK_TEXT } }]);

    await adapter.postInteractive(payload, { kind: 'clarify', question: { text: 'Which report?', options: ['Sales', 'Usage'] } } as never);
    expect(seen[1]?.path).toBe(`/amer/v3/conversations/${DM}/activities`);
    expect(appended.map((e) => e.payload)).toEqual([{ platform: 'teams', channel: DM, messageId: '1790000900002', role: 'other' }]);
  });

  it('without User.Read.All the map email stands in, and that is not an error', async () => {
    server.use(
      http.get(`${GRAPH}/users/:id`, () => HttpResponse.json({ error: { code: 'Authorization_RequestDenied', message: 'denied' } }, { status: 403 })),
    );
    const { adapter, onError } = setup();
    const { payload } = await handleInbound(adapter, inbound(activity('personal-text')));
    expect(payload.reporter).toEqual({ id: RAE, name: 'rae', email: 'rae@example.com', role: 'reporter' });
    await settle();
    expect(onError).not.toHaveBeenCalled();
  });

  it('a DM image becomes an incident with the image for the reader', async () => {
    const { adapter } = setup();
    const { payload } = await handleInbound(adapter, inbound(activity('personal-inline-image')));
    expect(payload.context.rawPayloadSnapshot['files']).toEqual([
      { kind: 'inline', url: 'https://smba.test/amer/v3/attachments/0-eus-d4-1a2b3c/views/original', contentType: 'image/*' },
    ]);
    await settle();
    expect(seen.map((s) => s.path)).toEqual([`/amer/v3/conversations/${DM}/activities`]);
  });

  it("the bot's own message and an unknown activity are ignored: typed results, and normalizePayload throws", async () => {
    const { adapter } = setup();
    const own = inbound(activity('own-message'));
    expect(await adapter.authenticateRequest(own)).toBe(true);
    expect(await adapter.normalizeResult(own)).toEqual({ kind: 'ignored', reason: 'own-message' });
    await expect(adapter.normalizePayload(own)).rejects.toBeInstanceOf(TeamsIgnoredError);
    const update = inbound(activity('conversation-update'));
    expect(await adapter.normalizeResult(update)).toEqual({ kind: 'ignored', reason: 'unsupported-activity' });
    await expect(adapter.normalizePayload(update)).rejects.toMatchObject({ reason: 'unsupported-activity' });
  });
});

describe('reaction trigger', () => {
  it("answers in the reactor's personal chat and posts in the thread through the channel's recorded serviceUrl", async () => {
    const { adapter, appended } = setup();
    // An earlier activity in the channel (any kind) recorded where to talk back.
    await adapter.authenticateRequest(inbound(activity('conversation-update')));
    await adapter.authenticateRequest(inbound(activity('action-submit-reply')));
    const message = activity('reaction-message') as unknown as GraphMessage;
    const raw: TeamsInbound = { transport: 'graph', trigger: { teamId: TEAM, channelId: CHANNEL, message, reaction: 'bug', reactorAadId: SAM } };
    const { payload, ack } = await handleInbound(adapter, raw);
    expect(payload.idempotencyKey).toBe(`teams-${CHANNEL}-1790000100555-bug`);
    expect(ack).toEqual({ status: 200 });
    await settle();
    expect(seen.map((s) => [s.method, s.path])).toEqual([
      ['POST', '/amer/v3/conversations'],
      ['POST', '/amer/v3/conversations/a:1personal-chat-sam/activities'],
    ]);
    expect(seen[0]?.body).toMatchObject({ isGroup: false, members: [{ id: SAM, aadObjectId: SAM }], tenantId: TENANT, bot: { id: APP_ID } });
    expect(seen[1]?.body).toEqual({ type: 'message', text: ACK_TEXT });

    await adapter.postInteractive(payload, { kind: 'dedupe', issueKey: 'WEB-1', summary: 'Coupons rejected' });
    expect(seen[2]?.path).toBe(`/amer/v3/conversations/${CHANNEL};messageid=${ROOT}/activities/${ROOT}`);
    expect(appended.map((e) => e.payload)).toEqual([{ platform: 'teams', channel: CHANNEL, messageId: '1790000900002', role: 'dedupe' }]);
  });

  it('without any serviceUrl the post fails loudly; the default serviceUrl covers a channel never heard from', async () => {
    const message = activity('reaction-message') as unknown as GraphMessage;
    const raw: TeamsInbound = { transport: 'graph', trigger: { teamId: TEAM, channelId: CHANNEL, message, reaction: 'bug', reactorAadId: SAM } };
    const bare = setup();
    const payload = await bare.adapter.normalizePayload(raw);
    await expect(bare.adapter.postInteractive(payload, { kind: 'scope-preview', summary: 'x' })).rejects.toThrow(/no serviceUrl/);
    const withDefault = setup({ defaultServiceUrl: SERVICE_URL });
    await withDefault.adapter.postInteractive(payload, { kind: 'scope-preview', summary: 'x' });
    expect(seen.at(-1)?.path).toBe(`/amer/v3/conversations/${CHANNEL};messageid=${ROOT}/activities/${ROOT}`);
  });
});

describe('status message', () => {
  it('posts in the thread and records it, then edits it in place; a deleted message is posted again', async () => {
    const { adapter, appended } = setup();
    const { payload } = await handleInbound(adapter, inbound(activity('action-fetch-task')));
    await adapter.postStatus(payload, { issueKey: 'WEB-1', stage: 'filed', text: 'Filed as WEB-1.' });
    expect(seen.map((s) => [s.method, s.path])).toEqual([['POST', `/amer/v3/conversations/${CHANNEL};messageid=${ROOT}/activities/${ROOT}`]]);
    await adapter.postStatus(payload, { issueKey: 'WEB-1', stage: 'fixing', text: 'Fixing now.' });
    expect(seen[1]).toMatchObject({ method: 'PUT', path: `/amer/v3/conversations/${CHANNEL};messageid=${ROOT}/activities/1790000900001` });
    expect(seen[1]?.body).toMatchObject({ id: '1790000900001' });
    expect(appended.map((e) => (e.payload as { role: string }).role)).toEqual(['status']);

    server.use(
      http.put(`${V3}/conversations/:conversation/activities/:activityId`, async ({ request }) => {
        await capture(request);
        return HttpResponse.json({ error: { code: 'ActivityNotFoundInConversation', message: 'gone' } }, { status: 404 });
      }),
    );
    await adapter.postStatus(payload, { issueKey: 'WEB-1', stage: 'pr-open', text: 'PR open.' });
    expect(seen.slice(2).map((s) => s.method)).toEqual(['PUT', 'POST']);
    expect(appended.map((e) => (e.payload as { messageId: string }).messageId)).toEqual(['1790000900001', '1790000900002']);
  });

  it('a note with no issue key is a plain card in the thread, recorded as other, never the status message', async () => {
    const { adapter, appended } = setup();
    const { payload } = await handleInbound(adapter, inbound(activity('action-fetch-task')));
    await adapter.postStatus(payload, { issueKey: '', stage: 'stopped', text: 'No bug then, closing this.' });
    await adapter.postStatus(payload, { issueKey: '', stage: 'stopped', text: 'Still closed.' });
    expect(seen.map((s) => s.method)).toEqual(['POST', 'POST']);
    expect(cardsPosted().map((c) => c.card.body.map((b) => b.text))).toEqual([['No bug then, closing this.'], ['Still closed.']]);
    expect(appended.map((e) => (e.payload as { role: string }).role)).toEqual(['other', 'other']);
  });

  it('a failing record never fails the post', async () => {
    const onError = vi.fn();
    const { adapter } = setup({ state: { read: () => Promise.reject(new Error('db down')), append: vi.fn() }, onError });
    const { payload } = await handleInbound(adapter, inbound(activity('action-fetch-task')));
    await adapter.postInteractive(payload, { kind: 'scope-preview', summary: 'Checkout total shows NaN' });
    expect(seen).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'db down' }));
  });
});

describe('reduced mode (ADR 0005)', () => {
  it("every card the adapter posts in a reduced team leads with the banner; a full team's cards do not", async () => {
    const { adapter, cache } = setup();
    const { payload } = await handleInbound(adapter, inbound(activity('action-fetch-task')));
    await adapter.postInteractive(payload, { kind: 'scope-preview', summary: 'Checkout total shows NaN' });
    expect(cardsPosted()[0]?.card.body[0]?.text).not.toBe(REDUCED_BANNER);

    await writeTeamsMode(cache, TEAM, 'reduced');
    await adapter.postInteractive(payload, { kind: 'scope-preview', summary: 'Checkout total shows NaN' });
    await adapter.postStatus(payload, { issueKey: 'WEB-1', stage: 'filed', text: 'Filed as WEB-1.' });
    await adapter.postStatus(payload, { issueKey: 'WEB-1', stage: 'fixing', text: 'Fixing now.' });
    await adapter.postStatus(payload, { issueKey: '', stage: 'stopped', text: 'A note.' });
    const reduced = cardsPosted().slice(1);
    expect(reduced).toHaveLength(4);
    for (const c of reduced) expect(c.card.body[0]?.text).toBe(REDUCED_BANNER);
    expect(cache.data.get(teamsConversationKey(CHANNEL))).toBeDefined();
  });

  it('a personal chat has no team, so no banner', async () => {
    const { adapter, cache } = setup();
    await writeTeamsMode(cache, TEAM, 'reduced');
    const { payload } = await handleInbound(adapter, inbound(activity('personal-text')));
    await adapter.postInteractive(payload, { kind: 'scope-preview', summary: 'Export does nothing' });
    expect(cardsPosted()[0]?.card.body[0]?.text).toBe('Export does nothing');
  });
});

describe('mentions', () => {
  it('a mention in a card resolves through the map to an <at> entity keyed by the AAD id', async () => {
    const { adapter } = setup();
    const { payload } = await handleInbound(adapter, inbound(activity('action-fetch-task')));
    await adapter.postStatus(payload, { issueKey: 'WEB-1', stage: 'filed', text: 'Filed as WEB-1.', mentionUserId: SAM });
    const [posted] = cardsPosted();
    expect(posted?.card.body[0]?.text).toContain('<at>sam</at>');
    expect((posted?.card as unknown as CanonicalIncidentPayload & { msteams: unknown }).msteams).toEqual({
      entities: [{ type: 'mention', text: '<at>sam</at>', mentioned: { id: SAM, name: 'sam' } }],
    });
  });
});
