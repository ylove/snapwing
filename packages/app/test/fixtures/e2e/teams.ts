// The Teams side of the composed app's end to end world, beside `slackWorld` in world.ts: the Bot
// Framework's OpenID metadata and a JWKS served from a key generated per run (so the messaging endpoint's
// token check is the real one), the token endpoint, the Bot Connector at the activities' serviceUrl, and
// Graph over one channel's messages and their inline images, whose reactions a test changes the way a
// person reacting would. The activities are the Teams fixtures pointed at that channel. The fake GitHub,
// the Jira webhooks, and the fake harness are the same ones the Slack end to end test uses
// (fixtures/e2e/). Every value here is a fake; none looks like a real credential.

import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import type { SetupServer } from 'msw/node';
import type { VerifiedNotification } from '../../../src/adapters/teams/subscriptions.ts';

export const APP_ID = '00000000-0000-4000-8000-0000000000b0';
export const APP_PASSWORD = 'test-teams-app-password';
export const TENANT = '7a0d5e6f-0000-4000-8000-0000000000c1';
export const TEAM = '2b9e4c7d-0000-4000-8000-0000000000a1';
export const SERVICE_URL = 'https://smba.test/amer/';
export const GRAPH = 'https://graph.microsoft.com/v1.0';
export const LOGIN = 'https://login.microsoftonline.com';
export const METADATA_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
export const JWKS_URL = 'https://login.botframework.com/v1/.well-known/keys';
export const ACCESS_TOKEN = 'test-teams-access-token';
export const TEAMS_SECRETS = { TEAMS_APP_ID: APP_ID, TEAMS_APP_PASSWORD: APP_PASSWORD, TEAMS_TENANT_ID: TENANT };
/** The subscription's subscriptionId in the notifications the tests hand in. */
export const SUBSCRIPTION_ID = '3c1f6a2e-0000-4000-8000-00000000f001';

export function teamsFixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../teams/${path}`, import.meta.url), 'utf8')) as Record<string, unknown>;
}

// The Bot Framework's signing key --------------------------------------------------------------------

const KID = 'e2e-teams-key';
const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });

/** A token for the messaging endpoint, signed with the key the JWKS serves. */
export function botFrameworkToken(): string {
  const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: KID });
  const body = b64({ iss: 'https://api.botframework.com', aud: APP_ID, nbf: now - 60, exp: now + 3600, serviceUrl: SERVICE_URL });
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), signing.privateKey).toString('base64url')}`;
}

/** A request to the messaging endpoint, with a valid token unless `authorization` says otherwise. */
export function activityRequest(base: string, activity: unknown, authorization: string | null = `Bearer ${botFrameworkToken()}`): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (authorization !== null) headers.set('authorization', authorization);
  return new Request(`${base}/teams/messages`, { method: 'POST', headers, body: JSON.stringify(activity) });
}

// The world ------------------------------------------------------------------------------------------

export interface ConnectorCall {
  kind: 'personal' | 'send' | 'reply' | 'update';
  conversation: string;
  /** The activity replied to or edited; for a post, the id the Connector gave it. */
  activityId: string;
  body: Record<string, unknown>;
  /** When the Connector took the call (epoch milliseconds). */
  at: number;
}

export interface GraphReaction {
  reactionType: string;
  createdDateTime: string;
  user: { user: { id: string; displayName: string | null; userIdentityType: 'aadUser' } };
}

export interface GraphChannelMessage extends Record<string, unknown> {
  id: string;
  reactions: GraphReaction[];
}

export interface TeamsWorld {
  /** Every Connector write, in order. */
  connector: ConnectorCall[];
  /** The Graph reads and subscriptions, as `kind id`. */
  graph: string[];
  /** Token requests, by scope. */
  scopes: string[];
  /** Methods or paths the world does not know; a test expects none. */
  unknown: string[];
  /** The channel's messages, as Graph serves them. */
  messages: GraphChannelMessage[];
  /** `userId` reacts to a message with `reactionType` (Graph's type, or the emoji itself). */
  react(messageId: string, userId: string, reactionType: string): void;
}

export interface TeamsWorldOptions {
  channel: string;
  /** The people who are members of the channel (for the channel members read). */
  members?: readonly string[];
  /** The status Graph answers a subscription with; 201 (default) is granted, 403 is a missing RSC grant. */
  subscriptionStatus?: number;
  /** Where the Bot Connector answers; default the fixtures' `SERVICE_URL`. */
  serviceUrl?: string;
  /** Inline images of the channel's messages, by hosted content id (Graph's `hostedContents/{id}/$value`). */
  hostedContents?: Readonly<Record<string, Uint8Array>>;
}

/** A Graph channel message by `user` (an AAD object id), HTML body `text`. */
export function graphMessage(id: string, at: string, text: string, user: string): GraphChannelMessage {
  return {
    id,
    replyToId: null,
    messageType: 'message',
    createdDateTime: at,
    lastModifiedDateTime: null,
    deletedDateTime: null,
    from: { application: null, device: null, user: { id: user, displayName: null, userIdentityType: 'aadUser' } },
    body: { contentType: 'html', content: `<p>${text}</p>` },
    attachments: [],
    mentions: [],
    reactions: [],
  };
}

/**
 * The Bot Framework keys, the token endpoint, the Connector at the fixtures' serviceUrl, and Graph over
 * `messages`. The Connector answers each post with a fresh activity id, so a test can find what a post
 * became and what later edited it.
 */
export function teamsWorld(server: SetupServer, messages: readonly GraphChannelMessage[], options: TeamsWorldOptions): TeamsWorld {
  const world: TeamsWorld = {
    connector: [],
    graph: [],
    scopes: [],
    unknown: [],
    messages: [...messages],
    react(messageId, userId, reactionType) {
      const message = world.messages.find((m) => m.id === messageId);
      if (message === undefined) throw new Error(`no message ${messageId}`);
      message.reactions.push({ reactionType, createdDateTime: new Date().toISOString(), user: { user: { id: userId, displayName: null, userIdentityType: 'aadUser' } } });
      message['lastModifiedDateTime'] = new Date().toISOString();
    },
  };
  let n = 0;
  const service = options.serviceUrl ?? SERVICE_URL;
  const authorized = (request: Request): boolean => request.headers.get('authorization') === `Bearer ${ACCESS_TOKEN}`;
  const denied = (): Response => HttpResponse.json({ error: { code: 'Unauthorized', message: 'no token' } }, { status: 401 });
  const id = (params: Record<string, unknown>, key: string): string => decodeURIComponent(String(params[key]));
  const json = async (request: Request): Promise<Record<string, unknown>> => (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const { n: modulus, e } = signing.publicKey.export({ format: 'jwk' });
  server.use(
    http.get(METADATA_URL, () => HttpResponse.json(teamsFixture('openid/openidconfiguration.json'))),
    http.get(JWKS_URL, () => HttpResponse.json({ keys: [{ kty: 'RSA', use: 'sig', kid: KID, n: modulus, e, endorsements: ['msteams'] }] })),
    http.post(`${LOGIN}/${TENANT}/oauth2/v2.0/token`, async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      world.scopes.push(form.get('scope') ?? '');
      if (form.get('client_id') !== APP_ID || form.get('client_secret') !== APP_PASSWORD) return HttpResponse.json(teamsFixture('openid/token-error.json'), { status: 401 });
      return HttpResponse.json(teamsFixture('openid/token-response.json'));
    }),
    // The Bot Connector.
    http.post(`${service}v3/conversations`, async ({ request }) => {
      if (!authorized(request)) return denied();
      world.connector.push({ kind: 'personal', conversation: '', activityId: '', body: await json(request), at: Date.now() });
      return HttpResponse.json({ id: 'a:1personal-chat' });
    }),
    http.post(`${service}v3/conversations/:conversation/activities`, async ({ request, params }) => {
      if (!authorized(request)) return denied();
      const activityId = `teams-act-${String(++n)}`;
      world.connector.push({ kind: 'send', conversation: id(params, 'conversation'), activityId, body: await json(request), at: Date.now() });
      return HttpResponse.json({ id: activityId });
    }),
    http.post(`${service}v3/conversations/:conversation/activities/:activity`, async ({ request, params }) => {
      if (!authorized(request)) return denied();
      const activityId = `teams-act-${String(++n)}`;
      world.connector.push({ kind: 'reply', conversation: id(params, 'conversation'), activityId, body: await json(request), at: Date.now() });
      return HttpResponse.json({ id: activityId });
    }),
    http.put(`${service}v3/conversations/:conversation/activities/:activity`, async ({ request, params }) => {
      if (!authorized(request)) return denied();
      world.connector.push({ kind: 'update', conversation: id(params, 'conversation'), activityId: id(params, 'activity'), body: await json(request), at: Date.now() });
      return HttpResponse.json({ id: id(params, 'activity') });
    }),
    // Graph: the channel's messages, replies, users (no User.Read.All: the map's email stands in), members, subscriptions.
    http.get(`${GRAPH}/teams/:team/channels/:channel/messages`, ({ request, params }) => {
      if (!authorized(request)) return denied();
      world.graph.push(`messages ${id(params, 'channel')}`);
      return HttpResponse.json({ value: [...world.messages].reverse() });
    }),
    http.get(`${GRAPH}/teams/:team/channels/:channel/messages/:message`, ({ request, params }) => {
      if (!authorized(request)) return denied();
      world.graph.push(`message ${id(params, 'message')}`);
      const found = world.messages.find((m) => m.id === id(params, 'message'));
      return found === undefined ? HttpResponse.json({ error: { code: 'NotFound', message: 'gone' } }, { status: 404 }) : HttpResponse.json(found);
    }),
    http.get(`${GRAPH}/teams/:team/channels/:channel/messages/:message/replies`, ({ request }) => (authorized(request) ? HttpResponse.json({ value: [] }) : denied())),
    // An inline image's bytes (the reader's hosted content download).
    http.get(/\/teams\/[^/]+\/channels\/[^/]+\/messages\/[^/]+\/hostedContents\/([^/]+)\/\$value$/, ({ request }) => {
      if (!authorized(request)) return denied();
      const content = decodeURIComponent(/\/hostedContents\/([^/]+)\/\$value$/.exec(new URL(request.url).pathname)?.[1] ?? '');
      world.graph.push(`hosted ${content}`);
      const bytes = options.hostedContents?.[content];
      return bytes === undefined ? HttpResponse.json({ error: { code: 'NotFound', message: 'gone' } }, { status: 404 }) : new HttpResponse(bytes, { headers: { 'content-type': 'image/png' } });
    }),
    // Everyone is a tenant member (the guest cap); no mail or name, so the map's stand in.
    http.get(`${GRAPH}/users/:user`, ({ params }) => HttpResponse.json({ id: params['user'], userType: 'Member' })),
    http.get(`${GRAPH}/teams/:team/channels/:channel/members`, ({ request, params }) => {
      if (!authorized(request)) return denied();
      world.graph.push(`members ${id(params, 'channel')}`);
      return HttpResponse.json({ value: (options.members ?? []).map((userId) => ({ id: `member-${userId}`, userId, roles: [] })) });
    }),
    http.post(`${GRAPH}/subscriptions`, async ({ request }) => {
      if (!authorized(request)) return denied();
      const body = await json(request);
      world.graph.push(`subscribe ${String(body['resource'])}`);
      const status = options.subscriptionStatus ?? 201;
      if (status !== 201) return HttpResponse.json({ error: { code: 'Forbidden', message: 'RSC grant missing' } }, { status });
      return HttpResponse.json({ ...teamsFixture('graph/subscription.json'), resource: body['resource'], expirationDateTime: body['expirationDateTime'], clientState: body['clientState'] }, { status: 201 });
    }),
  );
  return world;
}

// Activities and notifications -----------------------------------------------------------------------

export interface TeamsPerson {
  /** The AAD object id (the map's `teamsId`). */
  aad: string;
  /** The Bot Framework id (`29:...`). */
  botId: string;
  name: string;
}

export interface TeamsThread {
  channel: string;
  /** The thread root's message id (the anchor). */
  anchor: string;
  /** When the anchor was written (ISO 8601). */
  anchorAt: string;
}

/** The fixtures' channel data, pointed at this thread's channel. */
function channelDataOf(base: unknown, thread: TeamsThread): Record<string, unknown> {
  return { ...(base as Record<string, unknown>), channel: { id: thread.channel } };
}

/** A channel message by `from` as RSC delivers it: a root message when `replyTo` is absent. */
export function channelMessage(thread: TeamsThread, from: TeamsPerson, text: string, options: { id?: string; replyTo?: string } = {}): Record<string, unknown> {
  const reply = teamsFixture('notifications/reply-activity.json');
  const { replyToId: _drop, ...rest } = reply;
  return {
    ...rest,
    id: options.id ?? thread.anchor,
    timestamp: thread.anchorAt,
    serviceUrl: SERVICE_URL,
    from: { id: from.botId, name: from.name, aadObjectId: from.aad },
    conversation: { ...(reply['conversation'] as Record<string, unknown>), id: `${thread.channel};messageid=${thread.anchor}` },
    channelData: channelDataOf(reply['channelData'], thread),
    text: `<p>${text}</p>`,
    attachments: [{ contentType: 'text/html', content: `<p>${text}</p>` }],
    ...(options.replyTo === undefined ? {} : { replyToId: options.replyTo }),
  };
}

/** "Fix it from here" on the anchor, by `from`: the action command fixture on this thread. */
export function actionCommand(thread: TeamsThread, from: TeamsPerson, text: string): Record<string, unknown> {
  const activity = teamsFixture('activities/action-fetch-task.json');
  const value = activity['value'] as Record<string, unknown>;
  const message = value['messagePayload'] as Record<string, unknown>;
  const conversation = activity['conversation'] as Record<string, unknown>;
  delete message['linkToMessage'];
  return {
    ...activity,
    timestamp: thread.anchorAt,
    from: { id: from.botId, name: from.name, aadObjectId: from.aad },
    conversation: { ...conversation, id: `${thread.channel};messageid=${thread.anchor}` },
    channelData: channelDataOf(activity['channelData'], thread),
    value: {
      ...value,
      messagePayload: {
        ...message,
        id: thread.anchor,
        createdDateTime: thread.anchorAt,
        from: { user: { id: from.aad, displayName: from.name, userIdentityType: 'aadUser' }, application: null },
        body: { contentType: 'html', content: `<p>${text}</p>` },
        mentions: [],
      },
    },
  };
}

/**
 * A tap on a card in the thread, by `from`: the `Action.Execute` invoke Teams sends. `replyToId` is the
 * card's activity id, which is how the remembered card is found.
 */
export function cardTap(thread: TeamsThread, from: TeamsPerson, cardActivityId: string, verb: string, data: Record<string, string>): Record<string, unknown> {
  const command = actionCommand(thread, from, '');
  return {
    type: 'invoke',
    name: 'adaptiveCard/action',
    id: `tap-${verb}-${cardActivityId}`,
    timestamp: new Date().toISOString(),
    channelId: 'msteams',
    serviceUrl: SERVICE_URL,
    from: { id: from.botId, name: from.name, aadObjectId: from.aad },
    recipient: command['recipient'],
    conversation: command['conversation'],
    channelData: command['channelData'],
    replyToId: cardActivityId,
    value: { action: { type: 'Action.Execute', verb, data } },
  };
}

/**
 * A reaction by `from` on one of the bot's own messages in the thread, as Bot Framework delivers it
 * (`messageReaction`; Graph reports reactions on any message, Bot Framework only on the bot's).
 * `reactionType` is Teams' (`like` for 👍).
 */
export function botMessageReaction(thread: TeamsThread, from: TeamsPerson, activityId: string, reactionType: string): Record<string, unknown> {
  const reaction = teamsFixture('notifications/message-reaction-activity.json');
  return {
    ...reaction,
    id: `f:${activityId}-${reactionType}`,
    timestamp: new Date().toISOString(),
    serviceUrl: SERVICE_URL,
    from: { id: from.botId, name: from.name, aadObjectId: from.aad },
    conversation: { ...(reaction['conversation'] as Record<string, unknown>), id: `${thread.channel};messageid=${thread.anchor}` },
    channelData: channelDataOf(reaction['channelData'], thread),
    replyToId: activityId,
    reactionsAdded: [{ type: reactionType }],
  };
}

/** A message `from` sends the bot in their personal chat with it (`conversation` is that chat's id). */
export function personalMessage(from: TeamsPerson, conversation: string, text: string, id: string): Record<string, unknown> {
  const message = teamsFixture('activities/personal-text.json');
  return {
    ...message,
    id,
    text,
    timestamp: new Date().toISOString(),
    serviceUrl: SERVICE_URL,
    from: { id: from.botId, name: from.name, aadObjectId: from.aad },
    conversation: { ...(message['conversation'] as Record<string, unknown>), id: conversation },
  };
}

/** The change notification Graph sends when a channel message changes (a reaction, an edit). */
export function messageChanged(team: string, channel: string, messageId: string, changeType: 'created' | 'updated' = 'updated'): VerifiedNotification {
  return {
    subscriptionId: SUBSCRIPTION_ID,
    changeType,
    resource: `teams('${team}')/channels('${channel}')/messages('${messageId}')`,
    teamId: team,
    channelId: channel,
    messageId,
  };
}

// Reading what the app posted ------------------------------------------------------------------------

interface CardContent {
  actions?: { verb?: string; title?: string; data?: Record<string, string> }[];
  body?: unknown[];
}

/** The Adaptive Card an outgoing activity carries. */
export function cardOf(body: Record<string, unknown>): CardContent | undefined {
  const attachments = Array.isArray(body['attachments']) ? (body['attachments'] as { content?: unknown }[]) : [];
  return attachments[0]?.content as CardContent | undefined;
}

/** The verbs of a card's `Action.Execute` actions, in order. */
export function verbsOf(body: Record<string, unknown>): string[] {
  return (cardOf(body)?.actions ?? []).flatMap((a) => (a.verb === undefined ? [] : [a.verb]));
}

/** The text an activity shows: every text of its card, in order, else its `text`. */
export function activityText(body: Record<string, unknown>): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(walk);
    if (typeof node !== 'object' || node === null) return;
    const rec = node as Record<string, unknown>;
    if (rec['type'] === 'TextBlock' && typeof rec['text'] === 'string') parts.push(rec['text']);
    for (const value of Object.values(rec)) if (typeof value === 'object') walk(value);
  };
  walk(cardOf(body));
  return parts.length > 0 ? parts.join(' ') : String(body['text'] ?? '');
}
