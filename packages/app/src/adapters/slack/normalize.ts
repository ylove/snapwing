// Slack payload normalization (main 15.1, 14.2): message shortcut, trigger emoji reactions, and direct
// messages become a CanonicalIncidentPayload; everything else is a typed `ignored` result so the
// transport can acknowledge it. Emoji configuration comes from the parsed workspace map.

import type { CanonicalIncidentPayload, IncidentActor } from '@snapwing/pipeline/contracts/incident.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { ulid } from '@snapwing/pipeline/util/ulid.ts';
import { createSlackAuthorOf, type SlackAuthorOf } from './authorship.ts';

/** The callback id of the "Fix it from here" message shortcut in the Slack app manifest. */
export const SLACK_SHORTCUT_CALLBACK_ID = 'fix_it_from_here';

export interface SlackReactionsGetResult {
  /** The anchor message text, when Slack returned the message. */
  text?: string;
  threadTs?: string;
  reactions: { name: string; users: readonly string[] }[];
}

export interface SlackNormalizeContext {
  map: WorkspaceMap;
  /** The bot's own user id; its reactions and messages are ignored. */
  botUserId: string;
  /** `reactions.get` for a message; used to count distinct reactors and to read the anchor text. */
  reactionsGet: (channel: string, ts: string) => Promise<SlackReactionsGetResult>;
  callbackId?: string;
  /** Slack workspace subdomain, for the conversation deep link. */
  workspaceDomain?: string;
  newEventId?: (nowMs: number) => string;
  /**
   * Who wrote a direct message (`authorship.ts`): a person posting through an app carries `bot_id` and
   * is still a person. Default: the map and `botUserId` only.
   */
  authorOf?: SlackAuthorOf;
}

export type SlackIgnoreReason =
  | 'url-verification'
  | 'unsupported-payload'
  | 'unknown-callback'
  | 'own-reaction'
  | 'not-a-message-reaction'
  | 'not-a-trigger-emoji'
  | 'below-min-reactors'
  | 'not-a-direct-message'
  | 'own-message'
  | 'bot-message'
  | 'unsupported-subtype'
  | 'empty-message'
  | 'direct-message-disabled';

export type SlackNormalizeResult =
  | { kind: 'incident'; payload: CanonicalIncidentPayload }
  | { kind: 'ignored'; reason: SlackIgnoreReason };

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {};
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function isoFromTs(ts: string): string {
  const seconds = Number(ts);
  return new Date(Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0).toISOString();
}
const ignored = (reason: SlackIgnoreReason): SlackNormalizeResult => ({ kind: 'ignored', reason });
const stripTone = (name: string): string => name.replace(/::skin-tone-\d$/, '');

function actor(ctx: SlackNormalizeContext, id: string, fallbackName: string): IncidentActor {
  const person = ctx.map.people.find((p) => p.slackId === id);
  return {
    id,
    name: person?.handle ?? (fallbackName === '' ? id : fallbackName),
    ...(person?.email === undefined ? {} : { email: person.email }),
    role: person?.role ?? 'unknown',
  };
}

function build(
  ctx: SlackNormalizeContext,
  parts: {
    key: string;
    reporter: IncidentActor;
    anchorText: string;
    channel: string;
    anchorTs: string;
    threadTs?: string;
    timestampTs: string;
    snapshot: Rec;
  },
): CanonicalIncidentPayload {
  const timestamp = isoFromTs(parts.timestampTs);
  const link =
    ctx.workspaceDomain === undefined
      ? undefined
      : `https://${ctx.workspaceDomain}.slack.com/archives/${parts.channel}/p${parts.anchorTs.replace('.', '')}`;
  return {
    eventId: (ctx.newEventId ?? ulid)(Date.parse(timestamp)),
    idempotencyKey: parts.key,
    source: 'slack',
    reporter: parts.reporter,
    anchorText: parts.anchorText,
    context: {
      channelId: parts.channel,
      ...(parts.threadTs !== undefined && parts.threadTs !== parts.anchorTs ? { threadId: parts.threadTs } : {}),
      ...(link === undefined ? {} : { deepLink: link }),
      rawPayloadSnapshot: parts.snapshot,
    },
    timestamp,
  };
}

/** Normalize a parsed Slack payload (a `message_action` interactivity payload or an Events API envelope). */
export async function normalizeSlack(raw: unknown, ctx: SlackNormalizeContext): Promise<SlackNormalizeResult> {
  const body = rec(raw);
  if (body['type'] === 'message_action') return messageAction(body, ctx);
  if (body['type'] === 'url_verification') return ignored('url-verification');
  if (body['type'] !== 'event_callback') return ignored('unsupported-payload');
  const event = rec(body['event']);
  if (event['type'] === 'reaction_added') return reactionAdded(body, event, ctx);
  if (event['type'] === 'message') return directMessage(body, event, ctx);
  return ignored('unsupported-payload');
}

function messageAction(body: Rec, ctx: SlackNormalizeContext): SlackNormalizeResult {
  if (str(body['callback_id']) !== (ctx.callbackId ?? SLACK_SHORTCUT_CALLBACK_ID)) return ignored('unknown-callback');
  const channel = str(rec(body['channel'])['id']);
  const message = rec(body['message']);
  const ts = str(message['ts']) || str(body['message_ts']);
  const user = rec(body['user']);
  const userId = str(user['id']);
  if (channel === '' || ts === '' || userId === '') return ignored('unsupported-payload');
  const threadTs = str(message['thread_ts']);
  return {
    kind: 'incident',
    payload: build(ctx, {
      key: `slack-${channel}-${ts}`,
      reporter: actor(ctx, userId, str(user['name'])),
      anchorText: str(message['text']),
      channel,
      anchorTs: ts,
      ...(threadTs === '' ? {} : { threadTs }),
      timestampTs: ts,
      snapshot: { type: 'message_action', callback_id: str(body['callback_id']), ts, ...(threadTs === '' ? {} : { thread_ts: threadTs }) },
    }),
  };
}

/** Emoji that trigger in a channel: a channel override replaces the workspace default. Value is minReactors. */
function triggerEmoji(ctx: SlackNormalizeContext, channel: string): Map<string, number> {
  const override = ctx.map.channels.find((c) => c.id === channel)?.triggerEmoji ?? [];
  const workspace = new Map(ctx.map.triggers.emoji.map((e) => [e.slack, e.minReactors ?? 1]));
  if (override.length === 0) return workspace;
  return new Map(override.map((name) => [name, workspace.get(name) ?? 1]));
}

async function reactionAdded(body: Rec, event: Rec, ctx: SlackNormalizeContext): Promise<SlackNormalizeResult> {
  const userId = str(event['user']);
  if (userId !== '' && userId === ctx.botUserId) return ignored('own-reaction');
  const item = rec(event['item']);
  const channel = str(item['channel']);
  const ts = str(item['ts']);
  if (item['type'] !== 'message' || channel === '' || ts === '' || userId === '') return ignored('not-a-message-reaction');
  const reaction = stripTone(str(event['reaction']));
  const min = triggerEmoji(ctx, channel).get(reaction);
  if (min === undefined) return ignored('not-a-trigger-emoji');
  const got = await ctx.reactionsGet(channel, ts);
  const reactors = new Set<string>([userId]);
  for (const r of got.reactions) {
    if (stripTone(r.name) !== reaction) continue;
    for (const u of r.users) if (u !== ctx.botUserId) reactors.add(u);
  }
  if (reactors.size < min) return ignored('below-min-reactors');
  const threadTs = got.threadTs ?? '';
  return {
    kind: 'incident',
    payload: build(ctx, {
      key: `slack-${channel}-${ts}-${reaction}`,
      reporter: actor(ctx, userId, ''),
      anchorText: got.text ?? '',
      channel,
      anchorTs: ts,
      ...(threadTs === '' ? {} : { threadTs }),
      timestampTs: str(event['event_ts']) || ts,
      snapshot: { type: 'reaction_added', reaction, ts, reactors: [...reactors], event_id: str(body['event_id']) },
    }),
  };
}

async function directMessage(body: Rec, event: Rec, ctx: SlackNormalizeContext): Promise<SlackNormalizeResult> {
  if (event['channel_type'] !== 'im') return ignored('not-a-direct-message');
  const subtype = str(event['subtype']);
  const author = await (ctx.authorOf ?? createSlackAuthorOf({ botUserId: ctx.botUserId }))(event, ctx.map);
  if (author === 'own') return ignored('own-message');
  if (author === 'bot') return ignored('bot-message');
  if (subtype !== '' && subtype !== 'file_share') return ignored('unsupported-subtype');
  const userId = str(event['user']);
  const channel = str(event['channel']);
  const ts = str(event['ts']);
  if (userId === '' || channel === '' || ts === '') return ignored('unsupported-payload');
  const text = str(event['text']);
  const files = Array.isArray(event['files']) ? (event['files'] as unknown[]).map(rec) : [];
  const images = files.filter((f) => str(f['mimetype']).startsWith('image/'));
  const hasText = text.trim() !== '';
  if (!hasText && images.length === 0) return ignored('empty-message');
  const dm = ctx.map.triggers.directMessage;
  if (dm !== undefined && ((hasText && !dm.text && images.length === 0) || (images.length > 0 && !dm.images && !hasText))) {
    return ignored('direct-message-disabled');
  }
  return {
    kind: 'incident',
    payload: build(ctx, {
      key: `slack-${channel}-${ts}`,
      reporter: actor(ctx, userId, ''),
      anchorText: text,
      channel,
      anchorTs: ts,
      timestampTs: ts,
      snapshot: {
        type: 'message.im',
        ts,
        event_id: str(body['event_id']),
        files: images.map((f) => ({ id: str(f['id']), mimetype: str(f['mimetype']), url_private_download: str(f['url_private_download']) })),
      },
    }),
  };
}
