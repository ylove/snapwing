// DEMO ONLY (`pnpm demo`, main 14.3 reviewer demo mode). A fake Slack behind MSW, and the thin
// Slack-shaped adapter the demo drives it with. The real Slack adapter is phase 3 (main 15); nothing
// outside src/demo/ may import this file.
//
// Mock side (`SlackWorld`, `slackHandlers`): channel histories from the recordings, served on the
// Web API paths the real adapter will call (`conversations.history`, `conversations.replies`,
// `chat.postMessage`), checked against a fake bot token. Every post is kept and traced.
//
// Client side: `DemoSlackAdapter` (an IngestionAdapter over a signed `message_action` request),
// `DemoSlackReader` (a ChatReader over the Web API), and `demoSlackContext` (the engine's
// ContextSource). Cards carry the incident's event id in their metadata, as real buttons would, so
// the demo taps a card by reading it back from the world.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { nearestMidpoint, type ChatReader } from '../../context/chat-reader.ts';
import type { IngestionAdapter, InteractiveCard, StatusUpdate } from '../../contracts/adapters.ts';
import type { ActorRole, CanonicalIncidentPayload, SourceMessage } from '../../contracts/incident.ts';
import type { ContextSource } from '../../engine/deps.ts';
import { ulid } from '../../util/ulid.ts';

export const SLACK_API = 'https://slack.com/api';
/** Obvious fakes. The mock refuses any other value, so a real token can never be needed. */
export const DEMO_BOT_TOKEN = 'xoxb-test';
export const DEMO_SIGNING_SECRET = 'demo-signing-secret-not-real';
export const DEMO_WORKSPACE_DOMAIN = 'acme-demo';

/** A message as Slack's Web API returns it (the subset the demo uses). */
export interface SlackWireMessage {
  ts: string;
  user: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
}

/** A message the bot posted. `kind` is the card kind, or `status`. */
export interface SlackPost {
  channel: string;
  ts: string;
  threadTs?: string;
  kind: string;
  text: string;
  /** The incident's event id, from the post's metadata. */
  eventId?: string;
  /** The level the card was posted at (fix preview only). */
  level?: number;
}

export type TraceSink = (who: 'slack' | 'jira' | 'github', text: string) => void;

// Time --------------------------------------------------------------------------------------------

/** Slack `ts` ("1790845200.000100") to ISO 8601, microseconds dropped. */
export function isoFromTs(ts: string): string {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) throw new TypeError(`not a Slack ts: ${ts}`);
  return new Date(Math.floor(seconds * 1000)).toISOString();
}

/** ISO 8601 to a Slack `ts` bound for `oldest` and `latest`. */
export function tsFromIso(iso: string): string {
  return (Date.parse(iso) / 1000).toFixed(6);
}

// Mock side ---------------------------------------------------------------------------------------

export class SlackWorld {
  readonly channels = new Map<string, { name: string; messages: SlackWireMessage[] }>();
  readonly posts: SlackPost[] = [];
  #seq = 0;

  constructor(private readonly trace: TraceSink) {}

  addChannel(id: string, name: string, messages: readonly SlackWireMessage[]): void {
    const existing = this.channels.get(id);
    if (existing === undefined) this.channels.set(id, { name, messages: [...messages] });
    else existing.messages.push(...messages);
  }

  channelName(id: string): string {
    return this.channels.get(id)?.name ?? id;
  }

  /** The latest card the bot posted in `channel` under `threadTs`. */
  lastCard(channel: string, threadTs: string): SlackPost | undefined {
    for (let i = this.posts.length - 1; i >= 0; i--) {
      const p = this.posts[i];
      if (p !== undefined && p.channel === channel && p.threadTs === threadTs && p.kind !== 'status') return p;
    }
    return undefined;
  }

  post(input: Omit<SlackPost, 'ts'>): SlackPost {
    this.#seq += 1;
    const post: SlackPost = { ...input, ts: `1790900000.${String(this.#seq).padStart(6, '0')}` };
    this.posts.push(post);
    const label = post.kind === 'status' ? 'status' : `card ${post.kind}`;
    this.trace('slack', `chat.postMessage #${this.channelName(post.channel)} ${label}: ${post.text}`);
    return post;
  }
}

function authorized(request: Request): boolean {
  return request.headers.get('authorization') === `Bearer ${DEMO_BOT_TOKEN}`;
}

const NOT_AUTHED = { ok: false, error: 'not_authed' };

function topLevel(m: SlackWireMessage): boolean {
  return m.thread_ts === undefined || m.thread_ts === m.ts;
}

export function slackHandlers(world: SlackWorld): HttpHandler[] {
  return [
    http.get(`${SLACK_API}/conversations.history`, ({ request }) => {
      if (!authorized(request)) return HttpResponse.json(NOT_AUTHED);
      const q = new URL(request.url).searchParams;
      const channel = world.channels.get(q.get('channel') ?? '');
      if (channel === undefined) return HttpResponse.json({ ok: false, error: 'channel_not_found' });
      const oldest = Number(q.get('oldest') ?? '0');
      const latest = Number(q.get('latest') ?? `${Number.MAX_SAFE_INTEGER}`);
      const limit = Number(q.get('limit') ?? '100');
      const messages = channel.messages
        .filter((m) => topLevel(m) && Number(m.ts) >= oldest && Number(m.ts) <= latest)
        .sort((a, b) => Number(b.ts) - Number(a.ts)) // newest first, as Slack returns them
        .slice(0, limit)
        .map((m) => ({ type: 'message', ...m }));
      return HttpResponse.json({ ok: true, messages, has_more: false });
    }),
    http.get(`${SLACK_API}/conversations.replies`, ({ request }) => {
      if (!authorized(request)) return HttpResponse.json(NOT_AUTHED);
      const q = new URL(request.url).searchParams;
      const channel = world.channels.get(q.get('channel') ?? '');
      const ts = q.get('ts') ?? '';
      if (channel === undefined) return HttpResponse.json({ ok: false, error: 'channel_not_found' });
      const thread = channel.messages
        .filter((m) => m.ts === ts || m.thread_ts === ts)
        .sort((a, b) => Number(a.ts) - Number(b.ts))
        .map((m) => ({ type: 'message', ...m }));
      return HttpResponse.json({ ok: true, messages: thread, has_more: false });
    }),
    http.post(`${SLACK_API}/chat.postMessage`, async ({ request }) => {
      if (!authorized(request)) return HttpResponse.json(NOT_AUTHED);
      const body = asRecord(await request.json());
      const channel = str(body['channel']);
      const metadata = asRecord(body['metadata']);
      const eventPayload = asRecord(metadata['event_payload']);
      const eventType = str(metadata['event_type']);
      const threadTs = body['thread_ts'];
      const eventId = eventPayload['eventId'];
      const level = eventPayload['level'];
      const post = world.post({
        channel,
        ...(typeof threadTs === 'string' ? { threadTs } : {}),
        kind: eventType.replace(/^snapwing_/, ''),
        text: str(body['text']),
        ...(typeof eventId === 'string' ? { eventId } : {}),
        ...(typeof level === 'number' ? { level } : {}),
      });
      return HttpResponse.json({ ok: true, channel, ts: post.ts });
    }),
  ];
}

// Client side -------------------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

async function slackGet(method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const url = new URL(`${SLACK_API}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { authorization: `Bearer ${DEMO_BOT_TOKEN}` } });
  const body = asRecord(await res.json());
  if (body['ok'] !== true) throw new Error(`slack ${method}: ${str(body['error']) || `HTTP ${res.status}`}`);
  return body;
}

async function slackPost(method: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${DEMO_BOT_TOKEN}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });
  const body = asRecord(await res.json());
  if (body['ok'] !== true) throw new Error(`slack ${method}: ${str(body['error']) || `HTTP ${res.status}`}`);
}

function toSourceMessage(raw: unknown): SourceMessage {
  const m = asRecord(raw);
  const ts = str(m['ts']);
  const threadTs = m['thread_ts'];
  const replyCount = m['reply_count'];
  return {
    id: ts,
    authorId: str(m['user']),
    text: str(m['text']),
    timestamp: isoFromTs(ts),
    ...(typeof threadTs === 'string' && threadTs !== ts ? { threadParentId: threadTs } : {}),
    replyCount: typeof replyCount === 'number' ? replyCount : 0,
    mentions: [],
    reactions: [],
    attachments: [],
  };
}

/** ChatReader over the (mocked) Slack Web API. */
export class DemoSlackReader implements ChatReader {
  async history(channelId: string, oldest: string, latest: string, limit: number): Promise<SourceMessage[]> {
    const body = await slackGet('conversations.history', {
      channel: channelId,
      oldest: tsFromIso(oldest),
      latest: tsFromIso(latest),
      inclusive: 'true',
      // The wire limit keeps the newest; ask for the whole window and trim around the midpoint here.
      limit: '1000',
    });
    const messages = Array.isArray(body['messages']) ? body['messages'] : [];
    return nearestMidpoint(messages.map(toSourceMessage), oldest, latest, limit);
  }

  async replies(channelId: string, parentId: string): Promise<SourceMessage[]> {
    const body = await slackGet('conversations.replies', { channel: channelId, ts: parentId });
    const messages = Array.isArray(body['messages']) ? body['messages'] : [];
    return messages.map(toSourceMessage);
  }
}

/** The engine's ContextSource for Slack: the anchor is fetched again by its ts, so it is deterministic. */
export function demoSlackContext(reader: DemoSlackReader): ContextSource {
  return {
    reader,
    async anchor(payload) {
      const ts = str(payload.context.rawPayloadSnapshot['ts']);
      const body = await slackGet('conversations.history', {
        channel: payload.context.channelId,
        oldest: ts,
        latest: ts,
        inclusive: 'true',
        limit: '1',
      });
      const [first] = Array.isArray(body['messages']) ? body['messages'] : [];
      if (first === undefined) throw new Error(`slack: anchor ${ts} not found in ${payload.context.channelId}`);
      return { channelId: payload.context.channelId, message: toSourceMessage(first) };
    },
  };
}

/** A Slack interaction request as it reaches the server: signed headers and a form-encoded body. */
export interface SlackActionRequest {
  headers: { 'x-slack-signature': string; 'x-slack-request-timestamp': string };
  body: string;
}

function signature(timestamp: string, body: string): string {
  return `v0=${createHmac('sha256', DEMO_SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

/**
 * The demo playing Slack: a `message_action` ("Fix it from here") on `message` by `user`, signed with
 * the fake signing secret exactly as Slack signs a request.
 */
export function messageActionRequest(input: {
  channel: { id: string; name: string };
  user: { id: string; name: string };
  message: SlackWireMessage;
  now?: Date;
}): SlackActionRequest {
  const payload = {
    type: 'message_action',
    callback_id: 'fix_it_from_here',
    team: { domain: DEMO_WORKSPACE_DOMAIN },
    channel: input.channel,
    user: input.user,
    message_ts: input.message.ts,
    message: input.message,
  };
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const timestamp = String(Math.floor((input.now ?? new Date()).getTime() / 1000));
  return { headers: { 'x-slack-signature': signature(timestamp, body), 'x-slack-request-timestamp': timestamp }, body };
}

/** Five minutes, as Slack recommends, against replayed requests. */
const MAX_SKEW_SEC = 5 * 60;

function renderCard(card: InteractiveCard): { text: string; level?: number } {
  switch (card.kind) {
    case 'scope-preview':
      return { text: `${card.summary} [Looks right] [Widen] [Narrow]` };
    case 'dedupe': {
      const who = card.assignee === undefined ? '' : `, assigned to @${card.assignee}`;
      return { text: `Looks like ${card.issueKey} "${card.summary}"${who}. [Link] [Create anyway] [Not related]` };
    }
    case 'clarify': {
      const options = (card.question.options ?? []).map((o) => `[${o}]`).join(' ');
      return { text: `${card.question.text}${options === '' ? '' : ` ${options}`}` };
    }
    case 'fix-preview': {
      const { plan } = card;
      const head = `Fix preview, level ${plan.autonomyLevel}: "${plan.summary}" (${plan.priority})`;
      return {
        text: plan.autonomyLevel >= 2 ? `${head}, fixer starting. [Stop]` : `${head}. [Fix it] [Ticket only] [Dismiss]`,
        level: plan.autonomyLevel,
      };
    }
    case 'pr-ready':
      return {
        text: `PR #${card.prNumber} is ready for ${card.issueKey} (review agent: ${card.reviewVerdict}, CI: ${card.ciState}). [Open PR] [Merge] [Request changes] [Stop]`,
      };
  }
}

/** The demo's Slack IngestionAdapter. `roleOf` resolves a Slack user to a map role. */
export class DemoSlackAdapter implements IngestionAdapter<SlackActionRequest, { status: number; body: string }> {
  readonly channelSource = 'slack' as const;
  /** Every payload normalized, by idempotency key: how the demo learns an incident's id. */
  readonly received = new Map<string, CanonicalIncidentPayload>();

  constructor(
    private readonly roleOf: (slackId: string) => ActorRole,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  authenticateRequest(raw: SlackActionRequest): Promise<boolean> {
    const timestamp = raw.headers['x-slack-request-timestamp'];
    const age = Math.abs(this.clock().getTime() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > MAX_SKEW_SEC) return Promise.resolve(false);
    const expected = Buffer.from(signature(timestamp, raw.body));
    const given = Buffer.from(raw.headers['x-slack-signature']);
    return Promise.resolve(expected.length === given.length && timingSafeEqual(expected, given));
  }

  normalizePayload(raw: SlackActionRequest): Promise<CanonicalIncidentPayload> {
    const payload = asRecord(JSON.parse(new URLSearchParams(raw.body).get('payload') ?? '{}'));
    const channel = asRecord(payload['channel']);
    const user = asRecord(payload['user']);
    const message = asRecord(payload['message']);
    const channelId = str(channel['id']);
    const ts = str(message['ts']);
    const userId = str(user['id']);
    if (payload['type'] !== 'message_action' || channelId === '' || ts === '' || userId === '') {
      return Promise.reject(new TypeError('slack: not a message_action payload'));
    }
    const threadTs = message['thread_ts'];
    const normalized: CanonicalIncidentPayload = {
      eventId: ulid(this.clock().getTime()),
      idempotencyKey: `slack:${channelId}:${ts}`,
      source: 'slack',
      reporter: { id: userId, name: str(user['name']) || userId, role: this.roleOf(userId) },
      anchorText: str(message['text']),
      context: {
        channelId,
        ...(typeof threadTs === 'string' && threadTs !== ts ? { threadId: threadTs } : {}),
        deepLink: `https://${DEMO_WORKSPACE_DOMAIN}.slack.com/archives/${channelId}/p${ts.replace('.', '')}`,
        rawPayloadSnapshot: { ts, callback_id: str(payload['callback_id']) },
      },
      timestamp: isoFromTs(ts),
    };
    if (!this.received.has(normalized.idempotencyKey)) this.received.set(normalized.idempotencyKey, normalized);
    return Promise.resolve(normalized);
  }

  acknowledge(): Promise<{ status: number; body: string }> {
    return Promise.resolve({ status: 200, body: '' });
  }

  async postInteractive(payload: CanonicalIncidentPayload, card: InteractiveCard): Promise<void> {
    const { text, level } = renderCard(card);
    await slackPost('chat.postMessage', {
      channel: payload.context.channelId,
      thread_ts: str(payload.context.rawPayloadSnapshot['ts']),
      text,
      metadata: { event_type: `snapwing_${card.kind}`, event_payload: { eventId: payload.eventId, ...(level === undefined ? {} : { level }) } },
    });
  }

  async postStatus(payload: CanonicalIncidentPayload, status: StatusUpdate): Promise<void> {
    await slackPost('chat.postMessage', {
      channel: payload.context.channelId,
      thread_ts: str(payload.context.rawPayloadSnapshot['ts']),
      text: status.text,
      metadata: { event_type: 'snapwing_status', event_payload: { eventId: payload.eventId, issueKey: status.issueKey, stage: status.stage } },
    });
  }
}
