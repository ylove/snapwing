// The Teams transport on MSW (main 14.1, 15.2, #390). Requests go through the mounted routes as web-standard
// `Request`s; the Bot Framework JWT is the real check (#369) against a locally generated key served as the
// JWKS, endorsed for `msteams`. Graph's permission grants and channel messages are MSW too; an unhandled
// request fails the test, so no Microsoft endpoint is ever called.

import { generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ChannelSource } from '@snapwing/pipeline/contracts/incident.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { CachePort } from '@snapwing/pipeline/ports/cache.ts';
import type { Route } from '../../src/server/http.ts';
import { ACK_TEXT, ADAPTIVE_CARD_CONTENT_TYPE, createTeamsAdapter, type TeamsAdapter, type TeamsInbound } from '../../src/adapters/teams/adapter.ts';
import { createBotFrameworkKeys, verifyBotFrameworkJwt, type BotFrameworkKeys } from '../../src/adapters/teams/auth.ts';
import { createTeamsConnector } from '../../src/adapters/teams/connector.ts';
import { readTeamsMode, teamsConversationKey, teamsModeKey } from '../../src/adapters/teams/conversations.ts';
import { createTeamsGraph, type GraphSubscription } from '../../src/adapters/teams/graph.ts';
import { createTeamsSubscriptions, subscriptionIdKey, type LifecycleOutcome, type VerifiedNotification } from '../../src/adapters/teams/subscriptions.ts';
import {
  TEAMS_BUSY_TEXT,
  TEAMS_INVOKE_BUDGET_MS,
  TEAMS_LIFECYCLE_PATH,
  TEAMS_MESSAGES_PATH,
  TEAMS_NOTIFICATIONS_PATH,
  createTeamsModeCheck,
  createTeamsTransport,
  teamsQueueRoutes,
  type TeamsActivityRoute,
  type TeamsDispatcherOptions,
  type TeamsInvokeCard,
  type TeamsSignalsRoute,
  type TeamsTransport,
} from '../../src/adapters/teams/transport.ts';

const APP_ID = '00000000-0000-4000-8000-0000000000b0';
const BOT = `28:${APP_ID}`;
const CHANNEL = '19:5f3c0a7e9d2b4c1a8e6f@thread.tacv2';
const GENERAL = '19:general0a7e9d2b4c1a@thread.tacv2';
const TEAM = '2b9e4c7d-0000-4000-8000-0000000000a1';
const TENANT = '7a0d5e6f-0000-4000-8000-0000000000c1';
const RAE = '6f1c2a3b-0000-4000-8000-00000000a001';
const SAM = '6f1c2a3b-0000-4000-8000-00000000e001';
const SERVICE_URL = 'https://smba.test/amer/';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const BASE = 'https://snapwing.test';
const CLIENT_STATE = 'test-client-state-secret';
const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const NOW_S = NOW / 1000;

const METADATA_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
const JWKS_URL = 'https://login.botframework.com/v1/.well-known/keys';

// Keys and tokens ---------------------------------------------------------------------------------

interface Pair {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}
function pair(kid: string): Pair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, publicKey };
}
const served = pair('transport-key-1');
const stranger = pair('transport-key-stranger');

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jwt(overrides: Record<string, unknown> = {}, key: Pair = served): string {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: served.kid });
  const body = b64({ iss: 'https://api.botframework.com', aud: APP_ID, nbf: NOW_S - 60, exp: NOW_S + 3600, serviceUrl: SERVICE_URL, ...overrides });
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key.privateKey).toString('base64url')}`;
}

// Activities --------------------------------------------------------------------------------------

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../fixtures/teams/activities/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
}

function base(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type,
    id: `act-${type}`,
    timestamp: '2026-10-03T11:59:00.000Z',
    channelId: 'msteams',
    serviceUrl: SERVICE_URL,
    from: { id: '29:1sam-engineer-teams-id', name: 'Sam Engineer', aadObjectId: SAM },
    recipient: { id: BOT, name: 'Snapwing' },
    ...extra,
  };
}

const inChannel = {
  conversation: { conversationType: 'channel', tenantId: TENANT, id: `${CHANNEL};messageid=1790000100123` },
  channelData: { channel: { id: CHANNEL }, team: { id: GENERAL, aadGroupId: TEAM }, tenant: { id: TENANT } },
};

const statusQuestion = base('message', {
  ...inChannel,
  text: '<at>Snapwing</at> where are we with this?',
  entities: [{ type: 'mention', mentioned: { id: BOT, name: 'Snapwing' }, text: '<at>Snapwing</at>' }],
});
const threadReply = base('message', { ...inChannel, text: 'on it' });
const queueCommand = base('message', {
  text: 'queue',
  conversation: { conversationType: 'personal', tenantId: TENANT, id: 'a:1personal-chat-sam' },
  channelData: { tenant: { id: TENANT } },
});
const ownMessage = base('message', { ...inChannel, from: { id: BOT, name: 'Snapwing' }, text: 'Status: in review' });
const cardTap = base('invoke', {
  ...inChannel,
  name: 'adaptiveCard/action',
  value: { action: { type: 'Action.Execute', verb: 'dismiss', data: { incidentId: '01HZZZZZZZZZZZZZZZZZZZZZZZ' } } },
});
const reaction = base('messageReaction', {
  ...inChannel,
  replyToId: '1790000100999',
  reactionsAdded: [{ type: 'like' }],
});
const teamInstall = base('installationUpdate', { ...inChannel, action: 'add' });
const personalInstall = base('installationUpdate', {
  action: 'add',
  conversation: { conversationType: 'personal', tenantId: TENANT, id: 'a:1personal-chat-sam' },
  channelData: { tenant: { id: TENANT } },
});

// The world ---------------------------------------------------------------------------------------

const map: WorkspaceMap = {
  org: 'Example',
  updated: '2026-10-03T00:00:00Z',
  surfaces: [],
  channels: [{ id: CHANNEL, name: 'web-bugs', surface: 'web', platform: 'teams', teamId: TEAM, triggerEmoji: [] }],
  triggers: { messageActions: [{ label: 'Fix it from here' }], emoji: [{ slack: 'bug', teams: 'bug' }], directMessage: { images: true, text: true } },
  vocabulary: [],
  people: [
    { teamsId: RAE, handle: 'rae', email: 'rae@example.com', role: 'reporter', owns: [] },
    { teamsId: SAM, handle: 'sam', email: 'sam@example.com', role: 'engineer', owns: [] },
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
  };
}

let grants: { status: number; value: { id: string; clientAppId: string; permission: string; permissionType: string }[] };
let probeStatus = 200;
let graphCalls: string[] = [];

const server = setupServer(
  http.get(METADATA_URL, () => HttpResponse.json({ issuer: 'https://api.botframework.com', jwks_uri: JWKS_URL })),
  http.get(JWKS_URL, () => {
    const { n, e } = served.publicKey.export({ format: 'jwk' });
    return HttpResponse.json({ keys: [{ kty: 'RSA', use: 'sig', kid: served.kid, n, e, endorsements: ['msteams'] }] });
  }),
  http.get(`${GRAPH}/teams/:team/permissionGrants`, ({ params }) => {
    graphCalls.push(`grants ${String(params['team'])}`);
    if (grants.status !== 200) return HttpResponse.json({ error: { code: 'Forbidden', message: 'denied' } }, { status: grants.status });
    return HttpResponse.json({ value: grants.value });
  }),
  http.get(`${GRAPH}/teams/:team/channels/:channel/messages`, ({ params }) => {
    graphCalls.push(`probe ${String(params['channel'])}`);
    if (probeStatus !== 200) return HttpResponse.json({ error: { code: 'Forbidden', message: 'denied' } }, { status: probeStatus });
    return HttpResponse.json({ value: [] });
  }),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

interface World {
  transport: TeamsTransport;
  cache: ReturnType<typeof memoryCache>;
  adapter: TeamsAdapter;
  inbound: ReturnType<typeof vi.fn<(source: ChannelSource, raw: TeamsInbound) => Promise<unknown>>>;
  status: { intercepts: ReturnType<typeof vi.fn>; handle: ReturnType<typeof vi.fn> };
  signals: { observes: ReturnType<typeof vi.fn>; onActivity: ReturnType<typeof vi.fn>; onNotifications: ReturnType<typeof vi.fn> };
  queue: { command: ReturnType<typeof vi.fn>; install: ReturnType<typeof vi.fn> };
  action: ReturnType<typeof vi.fn<(activity: unknown) => Promise<TeamsInvokeCard | undefined>>>;
  lifecycle: LifecycleOutcome[][];
  errors: unknown[];
  graphSubscriptions: { renewed: string[]; created: number };
  route(path: string): Route;
}

const REFRESHED: TeamsInvokeCard & { body: unknown[] } = { type: 'AdaptiveCard', body: [{ type: 'TextBlock', text: 'Sam dismissed this' }] };

function textOf(activity: unknown): string {
  const t = (activity as { text?: unknown }).text;
  return typeof t === 'string' ? t : '';
}
function isChannel(activity: unknown): boolean {
  return (activity as { conversation?: { conversationType?: unknown } }).conversation?.conversationType === 'channel';
}

let keys: BotFrameworkKeys;

function world(overrides: Partial<TeamsDispatcherOptions> = {}): World {
  const cache = memoryCache();
  const adapter = createTeamsAdapter({
    connector: createTeamsConnector({ token: () => Promise.resolve('teams-test-token'), botId: APP_ID }),
    appId: APP_ID,
    verify: (authorization, o) => verifyBotFrameworkJwt(authorization, { ...o, keys, now: NOW }),
    cache,
    getMap: () => Promise.resolve(map),
    clock: () => new Date(NOW),
  });
  const inbound = vi.fn(async (_source: ChannelSource, raw: TeamsInbound): Promise<unknown> => {
    // The engine's request path: authenticate, normalize, (enqueue), acknowledge.
    if (!(await adapter.authenticateRequest(raw))) throw new Error('unauthorized');
    const payload = await adapter.normalizePayload(raw);
    return raw.transport === 'http' && (raw.activity as { type?: unknown }).type === 'invoke' ? adapter.acknowledge(raw, payload) : { status: 200 };
  });
  const status = {
    intercepts: vi.fn((a: unknown) => textOf(a).includes('<at>Snapwing</at>')),
    handle: vi.fn(() => Promise.resolve()),
  };
  const signals = {
    observes: vi.fn((a: unknown) => isChannel(a)),
    onActivity: vi.fn(() => Promise.resolve()),
    onNotifications: vi.fn((_n: readonly VerifiedNotification[]) => Promise.resolve()),
  };
  const queueCalls = { command: vi.fn(() => Promise.resolve()), install: vi.fn(() => Promise.resolve()) };
  const queue = teamsQueueRoutes({
    isQueueCommand: (a) => textOf(a).trim() === 'queue',
    handleCommand: queueCalls.command,
    isInstall: (a) => (a as { type?: unknown }).type === 'installationUpdate' && !isChannel(a),
    handleInstall: queueCalls.install,
  });
  const errors: unknown[] = [];
  const graphSubscriptions = { renewed: [] as string[], created: 0 };
  const sub = (id: string): GraphSubscription => ({
    id,
    resource: `/teams/${TEAM}/channels/getAllMessages`,
    changeType: 'created,updated',
    notificationUrl: `${BASE}${TEAMS_NOTIFICATIONS_PATH}`,
    expirationDateTime: new Date(NOW + 59 * 60_000).toISOString(),
  });
  const subscriptions = createTeamsSubscriptions({
    graph: {
      createSubscription: () => {
        graphSubscriptions.created += 1;
        return Promise.resolve(sub('sub-new'));
      },
      renewSubscription: (id) => {
        graphSubscriptions.renewed.push(id);
        return Promise.resolve(sub(id));
      },
    },
    cache,
    notificationUrl: `${BASE}${TEAMS_NOTIFICATIONS_PATH}`,
    lifecycleUrl: `${BASE}${TEAMS_LIFECYCLE_PATH}`,
    clientState: CLIENT_STATE,
    now: () => new Date(NOW),
  });
  const modeCheck = createTeamsModeCheck({
    graph: createTeamsGraph({ token: 'graph-test-token' }),
    cache,
    appId: APP_ID,
    getMap: () => Promise.resolve(map),
    onError: (e) => errors.push(e),
  });
  const action = vi.fn((_a: unknown): Promise<TeamsInvokeCard | undefined> => Promise.resolve(REFRESHED));
  const lifecycle: LifecycleOutcome[][] = [];
  const transport = createTeamsTransport({
    adapter,
    handleInbound: inbound,
    status,
    commands: [queue.command],
    interactivity: { onAction: action },
    signals: signals satisfies TeamsSignalsRoute,
    installs: [modeCheck, queue.install] satisfies TeamsActivityRoute[],
    subscriptions,
    onLifecycle: (outcomes) => void lifecycle.push([...outcomes]),
    onError: (e) => errors.push(e),
    ...overrides,
  });
  return {
    transport,
    cache,
    adapter,
    inbound,
    status,
    signals,
    queue: queueCalls,
    action,
    lifecycle,
    errors,
    graphSubscriptions,
    route(path) {
      const found = transport.routes.find((r) => r.path === path);
      if (found === undefined) throw new Error(`no route ${path}`);
      return found;
    },
  };
}

async function post(w: World, activity: unknown, authorization: string | null = `Bearer ${jwt()}`): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (authorization !== null) headers.set('authorization', authorization);
  const req = new Request(`${BASE}${TEAMS_MESSAGES_PATH}`, { method: 'POST', headers, body: typeof activity === 'string' ? activity : JSON.stringify(activity) });
  return w.route(TEAMS_MESSAGES_PATH).handler(req, { params: {} });
}

async function graphPost(w: World, path: string, body: unknown, query = ''): Promise<Response> {
  const req = new Request(`${BASE}${path}${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return w.route(path).handler(req, { params: {} });
}

/** Nothing any handler could have done, and nothing written. */
function untouched(w: World): void {
  expect(w.inbound).not.toHaveBeenCalled();
  expect(w.status.handle).not.toHaveBeenCalled();
  expect(w.signals.onActivity).not.toHaveBeenCalled();
  expect(w.signals.onNotifications).not.toHaveBeenCalled();
  expect(w.queue.command).not.toHaveBeenCalled();
  expect(w.queue.install).not.toHaveBeenCalled();
  expect(w.action).not.toHaveBeenCalled();
  expect(w.cache.data.size).toBe(0);
  expect(graphCalls).toEqual([]);
}

beforeEach(() => {
  keys = createBotFrameworkKeys();
  grants = { status: 200, value: [{ id: 'g1', clientAppId: APP_ID, permission: 'ChannelMessage.Read.Group', permissionType: 'Application' }] };
  probeStatus = 200;
  graphCalls = [];
});

describe('authentication first', () => {
  it('answers 401 and touches nothing without a token, with a bad token, or for another channel', async () => {
    const w = world();
    const personal = fixture('personal-text');
    expect((await post(w, personal, null)).status).toBe(401);
    expect((await post(w, personal, 'Bearer not-a-jwt')).status).toBe(401);
    expect((await post(w, personal, `Bearer ${jwt({}, stranger)}`)).status).toBe(401);
    expect((await post(w, personal, `Bearer ${jwt({ aud: 'someone-else' })}`)).status).toBe(401);
    expect((await post(w, personal, `Bearer ${jwt({ serviceUrl: 'https://evil.test/' })}`)).status).toBe(401);
    expect((await post(w, { ...personal, channelId: 'slack' })).status).toBe(401);
    expect((await post(w, 'not json')).status).toBe(401);
    expect((await post(w, cardTap, null)).status).toBe(401);
    expect((await post(w, fixture('action-fetch-task'), `Bearer ${jwt({}, stranger)}`)).status).toBe(401);
    expect((await post(w, teamInstall, null)).status).toBe(401);
    await w.transport.stop();
    untouched(w);
  });

  it('remembers the conversation once the token checks', async () => {
    const w = world();
    expect((await post(w, fixture('personal-text'))).status).toBe(200);
    expect(w.cache.data.has(teamsConversationKey('a:1personal-chat-rae'))).toBe(true);
  });
});

describe('message activities', () => {
  it('hands a personal-chat capture to handleInbound', async () => {
    const w = world();
    const res = await post(w, fixture('personal-text'));
    expect(res.status).toBe(200);
    expect(w.inbound).toHaveBeenCalledTimes(1);
    const [source, raw] = w.inbound.mock.calls[0] ?? [];
    expect(source).toBe('teams');
    expect(raw).toMatchObject({ transport: 'http', activity: { id: '1790000200456' } });
    expect(w.status.handle).not.toHaveBeenCalled();
  });

  it('sends an @mention status question to the status pull, not to capture', async () => {
    const w = world();
    expect((await post(w, statusQuestion)).status).toBe(200);
    await w.transport.stop();
    expect(w.status.handle).toHaveBeenCalledWith(expect.objectContaining({ text: statusQuestion['text'] }));
    expect(w.inbound).not.toHaveBeenCalled();
    expect(w.signals.onActivity).not.toHaveBeenCalled();
  });

  it('sends a bot command to its handler', async () => {
    const w = world();
    expect((await post(w, queueCommand)).status).toBe(200);
    await w.transport.stop();
    expect(w.queue.command).toHaveBeenCalledTimes(1);
    expect(w.inbound).not.toHaveBeenCalled();
  });

  it('sends a channel thread reply (read under RSC) to the signals', async () => {
    const w = world();
    expect((await post(w, threadReply)).status).toBe(200);
    await w.transport.stop();
    expect(w.signals.onActivity).toHaveBeenCalledWith(expect.objectContaining({ text: 'on it' }));
    expect(w.inbound).not.toHaveBeenCalled();
  });

  it("drops the bot's own message", async () => {
    const w = world();
    expect((await post(w, ownMessage)).status).toBe(200);
    await w.transport.stop();
    expect(w.signals.onActivity).not.toHaveBeenCalled();
    expect(w.status.handle).not.toHaveBeenCalled();
    expect(w.inbound).not.toHaveBeenCalled();
  });

  it('answers 500 when handleInbound fails, and reports the error', async () => {
    const w = world({ handleInbound: () => Promise.reject(new Error('queue down')) });
    expect((await post(w, fixture('personal-text'))).status).toBe(500);
    expect(w.errors).toHaveLength(1);
  });
});

describe('invokes', () => {
  it('answers a card tap with the refreshed card', async () => {
    const w = world();
    const res = await post(w, cardTap);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ statusCode: 200, type: ADAPTIVE_CARD_CONTENT_TYPE, value: REFRESHED });
    expect(w.action).toHaveBeenCalledWith(expect.objectContaining({ name: 'adaptiveCard/action' }));
    expect(w.inbound).not.toHaveBeenCalled();
  });

  it('answers a card tap inside the budget when the interactivity is slow, and lets it finish', async () => {
    let release: () => void = () => undefined;
    const slow = vi.fn(
      () =>
        new Promise<TeamsInvokeCard>((resolve) => {
          release = () => resolve(REFRESHED);
        }),
    );
    const w = world({ interactivity: { onAction: slow }, invokeBudgetMs: 100 });
    const started = Date.now();
    const res = await post(w, cardTap);
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ statusCode: 200, type: 'application/vnd.microsoft.activity.message', value: TEAMS_BUSY_TEXT });
    expect(elapsed).toBeLessThan(1000);
    expect(slow).toHaveBeenCalledTimes(1);
    release();
    await w.transport.stop();
    expect(w.errors).toEqual([]);
  });

  it('keeps the default budget under Teams’ 5 s', () => {
    expect(TEAMS_INVOKE_BUDGET_MS).toBeLessThan(5000);
  });

  it('answers a failed tap with an error response, not a 500', async () => {
    const w = world({ interactivity: { onAction: () => Promise.reject(new Error('boom')) } });
    const res = await post(w, cardTap);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ statusCode: 500, type: 'application/vnd.microsoft.error' });
    expect(w.errors).toHaveLength(1);
  });

  it('hands the action command (fetchTask and submitAction) to handleInbound and answers with its task message', async () => {
    const w = world();
    const fetchTask = await post(w, fixture('action-fetch-task'));
    expect(fetchTask.status).toBe(200);
    expect(await fetchTask.json()).toEqual({ task: { type: 'message', value: ACK_TEXT } });
    const submit = await post(w, fixture('action-submit-reply'));
    expect(submit.status).toBe(200);
    expect(await submit.json()).toEqual({ task: { type: 'message', value: ACK_TEXT } });
    expect(w.inbound).toHaveBeenCalledTimes(2);
    expect(w.inbound.mock.calls.map(([source]) => source)).toEqual(['teams', 'teams']);
  });

  it('answers the action command inside the budget when handleInbound is slow', async () => {
    let release: () => void = () => undefined;
    const handleInbound = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          release = () => resolve({ status: 200 });
        }),
    );
    const w = world({ handleInbound, invokeBudgetMs: 100 });
    const started = Date.now();
    const res = await post(w, fixture('action-fetch-task'));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await res.json()).toEqual({ task: { type: 'message', value: ACK_TEXT } });
    expect(handleInbound).toHaveBeenCalledTimes(1);
    release();
    await w.transport.stop();
    expect(w.errors).toEqual([]);
  });

  it('answers an unknown invoke 501', async () => {
    const w = world();
    expect((await post(w, base('invoke', { ...inChannel, name: 'signin/verifyState', value: {} }))).status).toBe(501);
    expect(w.action).not.toHaveBeenCalled();
    expect(w.inbound).not.toHaveBeenCalled();
  });
});

describe('reactions and installs', () => {
  it("sends a reaction on the bot's message to the signals", async () => {
    const w = world();
    expect((await post(w, reaction)).status).toBe(200);
    await w.transport.stop();
    expect(w.signals.onActivity).toHaveBeenCalledWith(expect.objectContaining({ type: 'messageReaction', replyToId: '1790000100999' }));
  });

  it('marks a team full when the grant is there, reduced when it is missing', async () => {
    const w = world();
    expect((await post(w, teamInstall)).status).toBe(200);
    await w.transport.stop();
    expect(w.cache.data.get(teamsModeKey(TEAM))).toBe('full');

    grants = { status: 200, value: [{ id: 'g2', clientAppId: 'another-app', permission: 'ChannelMessage.Read.Group', permissionType: 'Application' }] };
    expect((await post(w, fixture('conversation-update'))).status).toBe(200);
    await w.transport.stop();
    expect(await readTeamsMode(w.cache, TEAM)).toBe('reduced');
    expect(w.queue.install).not.toHaveBeenCalled();
    expect(graphCalls).toEqual([`grants ${TEAM}`, `grants ${TEAM}`]);
  });

  it('probes channel messages when it may not read the grants', async () => {
    const w = world();
    grants = { status: 403, value: [] };
    probeStatus = 403;
    await post(w, teamInstall);
    await w.transport.stop();
    expect(await readTeamsMode(w.cache, TEAM)).toBe('reduced');
    expect(graphCalls).toEqual([`grants ${TEAM}`, `probe ${CHANNEL}`]);

    probeStatus = 200;
    await post(w, teamInstall);
    await w.transport.stop();
    expect(await readTeamsMode(w.cache, TEAM)).toBe('full');
  });

  it("sends a personal install to the queue's first card, not the mode check", async () => {
    const w = world();
    expect((await post(w, personalInstall)).status).toBe(200);
    await w.transport.stop();
    expect(w.queue.install).toHaveBeenCalledTimes(1);
    expect(graphCalls).toEqual([]);
    expect(w.cache.data.has(teamsModeKey(TEAM))).toBe(false);
  });
});

describe('Graph notifications', () => {
  const resource = `teams('${TEAM}')/channels('${CHANNEL}')/messages('1790000100123')/replies('1790000100555')`;
  const notification = (clientState: string) => ({
    subscriptionId: 'sub-1',
    changeType: 'updated',
    clientState,
    resource,
    tenantId: TENANT,
    subscriptionExpirationDateTime: '2026-10-03T12:59:00.000Z',
  });

  it('passes the validation handshake on both routes', async () => {
    const w = world();
    for (const path of [TEAMS_NOTIFICATIONS_PATH, TEAMS_LIFECYCLE_PATH]) {
      const res = await graphPost(w, path, undefined, '?validationToken=Validation%3A%20Testing%20client%20application%20reachability');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect(await res.text()).toBe('Validation: Testing client application reachability');
    }
    untouched(w);
  });

  it('accepts a verified change notification and hands it to the signals', async () => {
    const w = world();
    const res = await graphPost(w, TEAMS_NOTIFICATIONS_PATH, { value: [notification(CLIENT_STATE)] });
    expect(res.status).toBe(202);
    await w.transport.stop();
    expect(w.signals.onNotifications).toHaveBeenCalledTimes(1);
    expect(w.signals.onNotifications.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ subscriptionId: 'sub-1', teamId: TEAM, channelId: CHANNEL, messageId: '1790000100123', replyId: '1790000100555' }),
    ]);
  });

  it('refuses a forged clientState and touches nothing', async () => {
    const w = world();
    expect((await graphPost(w, TEAMS_NOTIFICATIONS_PATH, { value: [notification('guessed-state')] })).status).toBe(403);
    expect((await graphPost(w, TEAMS_LIFECYCLE_PATH, { value: [{ ...notification('guessed-state'), lifecycleEvent: 'reauthorizationRequired' }] })).status).toBe(403);
    expect((await graphPost(w, TEAMS_NOTIFICATIONS_PATH, { nothing: true })).status).toBe(400);
    await w.transport.stop();
    expect(w.lifecycle).toEqual([]);
    expect(w.graphSubscriptions).toEqual({ renewed: [], created: 0 });
    untouched(w);
  });

  it('drops the forged notifications of a mixed batch', async () => {
    const w = world();
    const res = await graphPost(w, TEAMS_NOTIFICATIONS_PATH, { value: [notification('guessed-state'), { ...notification(CLIENT_STATE), subscriptionId: 'sub-2' }] });
    expect(res.status).toBe(202);
    await w.transport.stop();
    expect(w.signals.onNotifications.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ subscriptionId: 'sub-2' })]);
  });

  it('runs a verified lifecycle notification through the subscriptions and reports the outcome', async () => {
    const w = world();
    await w.cache.set(subscriptionIdKey('sub-1'), TEAM);
    await w.cache.set(`teams-subscription:${TEAM}`, JSON.stringify({ id: 'sub-1', expiresAt: new Date(NOW + 30 * 60_000).toISOString() }));
    const res = await graphPost(w, TEAMS_LIFECYCLE_PATH, {
      value: [
        { ...notification(CLIENT_STATE), lifecycleEvent: 'reauthorizationRequired' },
        { ...notification(CLIENT_STATE), subscriptionId: 'sub-9', lifecycleEvent: 'missed' },
      ],
    });
    expect(res.status).toBe(202);
    await w.transport.stop();
    expect(w.graphSubscriptions.renewed).toEqual(['sub-1']);
    expect(w.lifecycle).toEqual([[expect.objectContaining({ kind: 'reauthorized', subscriptionId: 'sub-1' }), { kind: 'missed', subscriptionId: 'sub-9' }]]);
    expect(w.signals.onNotifications).not.toHaveBeenCalled();
  });

  it('answers 404 on the notification routes when there are no subscriptions', async () => {
    const w = world();
    const bare = createTeamsTransport({ adapter: w.adapter, handleInbound: w.inbound });
    const route = bare.routes.find((r) => r.path === TEAMS_NOTIFICATIONS_PATH);
    const res = await route?.handler(new Request(`${BASE}${TEAMS_NOTIFICATIONS_PATH}?validationToken=x`, { method: 'POST' }), { params: {} });
    expect(res?.status).toBe(404);
  });
});
