// Slack as a `ContextSource` for the pipeline engine (main 5.2, 15.1): a `ChatReader` over
// conversations.history and conversations.replies with cursor pagination, a deterministic anchor, and
// an authorized image loader for the vision pass.

import { nearestMidpoint, type ChatReader } from '@snapwing/pipeline/context/chat-reader.ts';
import type { Anchor } from '@snapwing/pipeline/context/collect.ts';
import type { LoadImage, LoadRecording } from '@snapwing/pipeline/context/vision/index.ts';
import type { Attachment, CanonicalIncidentPayload, SourceMessage } from '@snapwing/pipeline/contracts/incident.ts';
import type { ContextSource } from '@snapwing/pipeline/engine/deps.ts';
import type { ImageMimeType } from '@snapwing/pipeline/ports/model.ts';
import {
  SlackApiError,
  SlackNotInvitedError,
  type SlackLinkAttachment,
  type SlackMessage,
  type SlackWeb,
} from './web.ts';

const PAGE_SIZE = 200;
/** A window never needs more than this many pages; a runaway cursor stops here. */
const MAX_PAGES = 25;
const IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
const SLACK_TS = /\d{9,11}\.\d{6}/;

/** What `createSlackContextSource` returns: a `ContextSource` plus the image loader to pass as `EngineOptions.loadImage`. */
export interface SlackContextSource extends ContextSource {
  reader: ChatReader;
  loadImage: LoadImage;
  /** Pass as `EngineOptions.loadRecording`. */
  loadRecording: LoadRecording;
}

export function isoToSlackTs(iso: string): string {
  return (Date.parse(iso) / 1000).toFixed(6);
}

export function slackTsToIso(ts: string): string {
  return new Date(Number(ts) * 1000).toISOString();
}

function mentionsOf(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(MENTION)) if (match[1] !== undefined) ids.add(match[1]);
  return [...ids];
}

function linkAttachment(a: SlackLinkAttachment): Attachment | undefined {
  const url = a.from_url ?? a.original_url ?? a.title_link;
  if (url === undefined) return undefined;
  const text = a.text ?? a.title ?? a.fallback;
  return text === undefined ? { kind: 'link', url } : { kind: 'link', url, extractedText: text };
}

export function toSourceMessage(m: SlackMessage, isTopLevelFromHistory = false): SourceMessage {
  const text = m.text ?? '';
  const attachments: Attachment[] = [];
  for (const file of m.files ?? []) {
    const url = file.url_private_download ?? file.url_private;
    if (url === undefined) continue;
    const isImage = file.mimetype !== undefined && file.mimetype.startsWith('image/');
    attachments.push(
      file.mimetype === undefined
        ? { kind: isImage ? 'image' : 'file', url }
        : { kind: isImage ? 'image' : 'file', url, mimeType: file.mimetype },
    );
  }
  for (const a of m.attachments ?? []) {
    const link = linkAttachment(a);
    if (link !== undefined) attachments.push(link);
  }
  const message: SourceMessage = {
    id: m.ts,
    authorId: m.user ?? m.bot_id ?? '',
    text,
    timestamp: slackTsToIso(m.ts),
    mentions: mentionsOf(text),
    reactions: (m.reactions ?? []).map((r) => r.name),
    attachments,
  };
  if (m.thread_ts !== undefined && m.thread_ts !== m.ts) message.threadParentId = m.thread_ts;
  if (m.reply_count !== undefined) message.replyCount = m.reply_count;
  else if (isTopLevelFromHistory) message.replyCount = 0;
  return message;
}

/**
 * Runs `op`; on `not_in_channel` tries `conversations.join` once and retries `op` once. A channel the
 * bot cannot join (a private one) or still is not in becomes `SlackNotInvitedError`.
 */
async function withJoin<T>(web: SlackWeb, channelId: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (!(err instanceof SlackApiError) || err.error !== 'not_in_channel') throw err;
  }
  try {
    await web.conversationsJoin(channelId);
  } catch (err) {
    if (err instanceof SlackApiError) throw new SlackNotInvitedError(channelId);
    throw err;
  }
  try {
    return await op();
  } catch (err) {
    if (err instanceof SlackApiError && err.error === 'not_in_channel') throw new SlackNotInvitedError(channelId);
    throw err;
  }
}

export function createSlackChatReader(web: SlackWeb): ChatReader {
  return {
    async history(channelId, oldest, latest, limit) {
      const collected: SlackMessage[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await withJoin(web, channelId, () =>
          web.conversationsHistory({
            channel: channelId,
            oldest: isoToSlackTs(oldest),
            latest: isoToSlackTs(latest),
            inclusive: true,
            limit: PAGE_SIZE,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        );
        collected.push(...res.messages);
        cursor = res.nextCursor;
        if (cursor === undefined) break;
      }
      const topLevel = collected
        .filter((m) => m.thread_ts === undefined || m.thread_ts === m.ts)
        .map((m) => toSourceMessage(m, true));
      return nearestMidpoint(topLevel, oldest, latest, limit);
    },

    async replies(channelId, parentId) {
      const collected: SlackMessage[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await withJoin(web, channelId, () =>
          web.conversationsReplies({
            channel: channelId,
            ts: parentId,
            limit: PAGE_SIZE,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        );
        collected.push(...res.messages);
        cursor = res.nextCursor;
        if (cursor === undefined) break;
      }
      // A message with no thread comes back as itself alone.
      if (collected.every((m) => m.ts === parentId)) return [];
      return collected
        .map((m) => toSourceMessage(m))
        .sort((a, b) => Number(a.id) - Number(b.id));
    },
  };
}

/** The Slack ts of the message a payload is anchored on, from the raw snapshot or the idempotency key. */
export function anchorTsOf(payload: CanonicalIncidentPayload): string | undefined {
  const raw = payload.context.rawPayloadSnapshot;
  const nested = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const candidates = [
    raw['messageTs'],
    raw['message_ts'],
    nested(raw['message'])['ts'],
    nested(raw['item'])['ts'],
    nested(raw['event'])['ts'],
    raw['ts'],
  ];
  for (const c of candidates) if (typeof c === 'string' && SLACK_TS.test(c)) return c;
  // `slack-{channel}-{ts}` and `slack-{channel}-{ts}-{reaction}` (main 14.2).
  const fromKey = SLACK_TS.exec(payload.idempotencyKey);
  return fromKey?.[0];
}

/**
 * Downloads an image attachment from `url_private_download` with the bot token in the `Authorization`
 * header (main 15.1). Returns undefined for anything that is not a readable image.
 */
export function createSlackImageLoader(web: SlackWeb): LoadImage {
  return async (attachment) => {
    if (attachment.kind !== 'image') return undefined;
    try {
      const file = await web.downloadFile(attachment.url);
      const mimeType = IMAGE_TYPES.includes(file.contentType) ? file.contentType : attachment.mimeType;
      if (mimeType === undefined || !IMAGE_TYPES.includes(mimeType) || file.bytes.length === 0) return undefined;
      return {
        mimeType: mimeType as ImageMimeType,
        data: Buffer.from(file.bytes).toString('base64'),
        ref: attachment.url,
      };
    } catch {
      return undefined;
    }
  };
}

/**
 * Downloads a video attachment from `url_private_download` with the bot token in the `Authorization`
 * header (main 15.1, A 5.1). Returns undefined for anything that is not a video or comes back empty.
 */
export function createSlackRecordingLoader(web: SlackWeb): LoadRecording {
  return async (attachment) => {
    if (attachment.kind !== 'file' || attachment.mimeType?.toLowerCase().startsWith('video/') !== true) return undefined;
    try {
      const file = await web.downloadFile(attachment.url);
      // Slack answers an expired or unauthorized download with an HTML page; that is not a recording.
      if (file.contentType.startsWith('text/') || file.bytes.length === 0) return undefined;
      return file.bytes;
    } catch {
      return undefined;
    }
  };
}

export function createSlackContextSource(web: SlackWeb): SlackContextSource {
  const reader = createSlackChatReader(web);
  return {
    reader,
    loadImage: createSlackImageLoader(web),
    loadRecording: createSlackRecordingLoader(web),
    async anchor(payload): Promise<Anchor> {
      const channelId = payload.context.channelId;
      const ts = anchorTsOf(payload);
      const direct = channelId.startsWith('D');
      if (ts === undefined) {
        throw new SlackApiError('anchor', 'anchor_ts_missing');
      }
      const parent = payload.context.threadId ?? ts;
      const res = await withJoin(web, channelId, () =>
        web.conversationsReplies({ channel: channelId, ts: parent, oldest: ts, latest: ts, inclusive: true, limit: 1 }),
      );
      const found = res.messages.find((m) => m.ts === ts);
      if (found === undefined) throw new SlackApiError('anchor', 'message_not_found');
      const message = toSourceMessage(found);
      return direct ? { channelId, message, direct: true } : { channelId, message };
    },
  };
}
