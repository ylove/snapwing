// Teams as a `ContextSource` for the pipeline engine (main 5.2, 5.2a, 15.2): a `ChatReader` over Graph
// channel messages and replies, a deterministic anchor, and loaders for inline images (hosted
// contents), channel files (SharePoint through Graph) and personal-chat attachments (`contentUrl`
// with the bot token). Mirrors `adapters/slack/reader.ts`.
//
// Which token goes where (#269):
// - The bot token goes only to a Bot Connector attachment (`.../v3/attachments/{id}/views/{view}`) on an
//   exact Bot Connector host (`TEAMS_SERVICE_HOSTS`, plus a configured service URL's host). Such a URL
//   reaches the loader only from an activity's own attachments: a message read back from Graph never yields
//   one (`toSourceMessage` drops it), so Graph content is read with the Graph token or not at all.
// - An inline image (a Graph hosted content) is kept only when its URL names the message being read: the
//   same team, channel, and message (a reply's URL names its root and itself). One naming any other message
//   is dropped, so a message body cannot pull another conversation's image into the context.
//
// Without the RSC grant (`GraphPermissionError`) the reader reads nothing around the anchor; the
// context source says so through `limitation`, and the scope preview reports it (15.2 history row).

import { nearestMidpoint, type ChatReader } from '@snapwing/pipeline/context/chat-reader.ts';
import type { Anchor } from '@snapwing/pipeline/context/collect.ts';
import type { LoadImage, LoadRecording } from '@snapwing/pipeline/context/vision/index.ts';
import type { Attachment, CanonicalIncidentPayload, SourceMessage } from '@snapwing/pipeline/contracts/incident.ts';
import type { ContextLimitation, ContextSource } from '@snapwing/pipeline/engine/deps.ts';
import type { ImageMimeType } from '@snapwing/pipeline/ports/model.ts';
import { onTeamsServiceHost, teamsServiceHosts } from './connector.ts';
import { GRAPH_BASE_URL, GraphApiError, GraphPermissionError, type GraphAttachment, type GraphMessage, type TeamsGraph } from './graph.ts';

const IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};
/** Graph returns a channel's messages newest first, 50 a page; the graph client caps the pages. */
const PAGE_SIZE = 50;
/** A Bot Connector attachment's path (`{serviceUrl}v3/attachments/{id}/views/{view}`): the only URL the bot token is sent to. */
const BOT_ATTACHMENT_PATH = /\/v3\/attachments\/[^/]+\/views\/[^/]+$/;
const GRAPH_ORIGIN = new URL(GRAPH_BASE_URL).origin;

/** Teams has no team in a personal chat or an unmapped channel: nothing to read around the anchor. */
export class TeamsContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamsContextError';
  }
}

export interface TeamsChatReaderOptions {
  /** The team (group id) a channel belongs to; the map's `channel.team`. Undefined means nothing to read. */
  teamFor?: (channelId: string) => string | undefined;
}

export interface TeamsContextSourceOptions extends TeamsChatReaderOptions {
  /** The bot's Bot Framework token, for personal-chat attachments. Absent means those are not loaded. */
  botToken?: () => string | Promise<string>;
  /** Exact hosts beside `TEAMS_SERVICE_HOSTS` that may receive the bot token (a configured `TEAMS_SERVICE_URL`'s host). */
  botHosts?: readonly string[];
  fetch?: typeof fetch;
}

/** What `createTeamsContextSource` returns: a `ContextSource` plus the loaders to pass as engine options. */
export interface TeamsContextSource extends ContextSource {
  reader: ChatReader;
  loadImage: LoadImage;
  /** Pass as `EngineOptions.loadRecording`. */
  loadRecording: LoadRecording;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (dec !== undefined) return String.fromCodePoint(Number(dec));
    if (hex !== undefined) return String.fromCodePoint(parseInt(hex, 16));
    return (name === undefined ? undefined : ENTITIES[name.toLowerCase()]) ?? whole;
  });
}

/** The user id Graph names for mention `index`, as a marker that becomes `<@id>` once the tags are gone; an unresolved mention keeps its text. */
function mentionMarker(message: GraphMessage, index: string, shown: string): { text: string; id?: string } {
  const found = message.mentions?.find((m) => String(m.id) === index);
  const id = found?.mentioned.user?.id ?? found?.mentioned.application?.id;
  return id === undefined ? { text: shown } : { text: `\uE000${id}\uE001`, id };
}

const IMG_SRC = /<img\b[^>]*?\bsrc="([^"]*)"[^>]*>/gi;

/** A message body as plain text with mentions as `<@aadObjectId>`, and the ids mentioned. */
export function bodyToText(message: GraphMessage): { text: string; mentions: string[] } {
  const body = message.body;
  if (body === undefined) return { text: '', mentions: [] };
  if (body.contentType !== 'html') return { text: body.content, mentions: [] };
  const mentions = new Set<string>();
  const text = body.content
    .replace(/<at\b[^>]*?\bid="(\d+)"[^>]*>([\s\S]*?)<\/at>/gi, (_w, index: string, shown: string) => {
      const marker = mentionMarker(message, index, decodeEntities(shown.replace(/<[^>]*>/g, '')));
      if (marker.id !== undefined) mentions.add(marker.id);
      return marker.text;
    })
    .replace(/<emoji\b[^>]*?\balt="([^"]*)"[^>]*>(?:<\/emoji>)?/gi, '$1')
    .replace(/<attachment\b[^>]*>(?:<\/attachment>)?/gi, '')
    .replace(IMG_SRC, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|blockquote|tr)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]*>/g, '');
  return {
    text: decodeEntities(text)
      .replace(/\uE000([^\uE001]*)\uE001/g, '<@$1>')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    mentions: [...mentions],
  };
}

function extensionType(name: string | null | undefined): string | undefined {
  const dot = name?.lastIndexOf('.') ?? -1;
  if (name === null || name === undefined || dot < 0) return undefined;
  return EXTENSION_TYPES[name.slice(dot + 1).toLowerCase()];
}

function fileAttachment(a: GraphAttachment): Attachment | undefined {
  if (a.contentUrl === null || a.contentUrl === undefined || a.contentUrl === '') return undefined;
  const mimeType = a.contentType.includes('/') && a.contentType !== 'application/vnd.microsoft.teams.file.download.info' ? a.contentType : extensionType(a.name ?? new URL(a.contentUrl).pathname);
  const kind = mimeType?.startsWith('image/') === true ? 'image' : 'file';
  return mimeType === undefined ? { kind, url: a.contentUrl } : { kind, url: a.contentUrl, mimeType };
}

/** Where a channel message lives: the team's group id and the channel. */
export interface MessagePlace {
  teamId: string;
  channelId: string;
}

/** The team, channel, message, reply, and content a Graph hosted-content URL names; undefined for any other URL. */
function hostedPartsOf(url: string): { team: string; channel: string; message: string; reply?: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.origin !== GRAPH_ORIGIN) return undefined;
  const found = HOSTED_PARTS.exec(parsed.pathname);
  if (found === null) return undefined;
  try {
    const [, team, channel, message, reply] = found.map((p) => (p === undefined ? p : decodeURIComponent(p)));
    if (team === undefined || channel === undefined || message === undefined) return undefined;
    return { team, channel, message, ...(reply === undefined ? {} : { reply }) };
  } catch {
    return undefined;
  }
}

/**
 * True when a hosted-content URL names the message being read (#269): its team and channel, and the
 * message itself (a root post), or its root and itself (a reply). Anything else is another message's image.
 */
function namesMessage(url: string, at: MessagePlace | undefined, messageId: string, parentId: string | undefined): boolean {
  const parts = hostedPartsOf(url);
  if (parts === undefined || at === undefined) return false;
  if (parts.team.toLowerCase() !== at.teamId.toLowerCase() || parts.channel !== at.channelId) return false;
  const reply = parentId !== undefined && parentId !== '' && parentId !== messageId;
  return reply ? parts.message === parentId && parts.reply === messageId : parts.message === messageId && parts.reply === undefined;
}

/** A Bot Connector attachment URL, on any host: the bot token's kind of URL, which a Graph read never passes on. */
function isBotAttachment(url: string): boolean {
  try {
    return BOT_ATTACHMENT_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * A Graph message as a source message. `at` is where it was read from; an inline image or attachment that
 * is a hosted content of any other message is dropped, as is anything shaped like a Bot Connector
 * attachment (the bot token's), so nothing read back from Graph is ever fetched with the bot token.
 */
export function toSourceMessage(m: GraphMessage, at: MessagePlace | undefined, replyCount?: number): SourceMessage {
  const { text, mentions } = bodyToText(m);
  const attachments: Attachment[] = [];
  const parentId = m.replyToId ?? undefined;
  if (m.body?.contentType === 'html') {
    for (const match of m.body.content.matchAll(IMG_SRC)) {
      const src = match[1] === undefined ? undefined : decodeEntities(match[1]);
      if (src !== undefined && HOSTED_CONTENT.test(src) && namesMessage(src, at, m.id, parentId)) attachments.push({ kind: 'image', url: src });
    }
  }
  for (const a of m.attachments ?? []) {
    const file = fileAttachment(a);
    if (file === undefined || isBotAttachment(file.url)) continue;
    if (hostedPartsOf(file.url) !== undefined && !namesMessage(file.url, at, m.id, parentId)) continue;
    attachments.push(file);
  }
  const message: SourceMessage = {
    id: m.id,
    authorId: m.from?.user?.id ?? m.from?.application?.id ?? '',
    text,
    timestamp: new Date(m.createdDateTime).toISOString(),
    mentions,
    reactions: (m.reactions ?? []).map((r) => r.reactionType),
    attachments,
  };
  if (m.replyToId !== undefined && m.replyToId !== null && m.replyToId !== '') message.threadParentId = m.replyToId;
  else if (replyCount !== undefined) message.replyCount = replyCount;
  return message;
}

/** `replies@odata.count`, which Graph gives when a message list is expanded with its replies. */
function replyCountOf(m: GraphMessage): number | undefined {
  const count = (m as unknown as Record<string, unknown>)['replies@odata.count'];
  return typeof count === 'number' ? count : undefined;
}

const isReadable = (m: GraphMessage): boolean =>
  (m.messageType === undefined || m.messageType === 'message') && (m.deletedDateTime === undefined || m.deletedDateTime === null);

export function createTeamsChatReader(graph: TeamsGraph, options: TeamsChatReaderOptions = {}): ChatReader {
  const teamOf = (channelId: string): string | undefined => options.teamFor?.(channelId);
  return {
    async history(channelId, oldest, latest, limit) {
      const teamId = teamOf(channelId);
      if (teamId === undefined) return [];
      let raw: GraphMessage[];
      try {
        // The only time filter Graph takes on channel messages is on `lastModifiedDateTime`; the window
        // is on creation time, so it is cut here.
        raw = await graph.channelMessages(teamId, channelId, { top: PAGE_SIZE, since: oldest });
      } catch (err) {
        if (err instanceof GraphPermissionError) return [];
        throw err;
      }
      const from = Date.parse(oldest);
      const to = Date.parse(latest);
      const topLevel = raw
        .filter((m) => isReadable(m) && (m.replyToId === undefined || m.replyToId === null))
        .filter((m) => {
          const t = Date.parse(m.createdDateTime);
          return t >= from && t <= to;
        })
        .map((m) => toSourceMessage(m, { teamId, channelId }, replyCountOf(m)));
      return nearestMidpoint(topLevel, oldest, latest, limit);
    },

    async replies(channelId, parentId) {
      const teamId = teamOf(channelId);
      if (teamId === undefined) return [];
      try {
        const replies = (await graph.channelReplies(teamId, channelId, parentId)).filter(isReadable);
        if (replies.length === 0) return [];
        const parent = await graph.message(teamId, channelId, parentId);
        const byId = new Map<string, SourceMessage>();
        for (const m of [parent, ...replies]) byId.set(m.id, toSourceMessage(m, { teamId, channelId }, m.id === parentId ? replies.length : undefined));
        return [...byId.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id));
      } catch (err) {
        if (err instanceof GraphPermissionError) return [];
        throw err;
      }
    },
  };
}

const MESSAGE_KEY = /(\d{10,})(?:-[^-]+)?$/;

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) if (typeof c === 'string' && c !== '') return c;
  return undefined;
}

/** The Graph message id a payload is anchored on, from the raw snapshot or the `teams-{conversation}-{activity}` key. */
export function anchorIdOf(payload: CanonicalIncidentPayload): string | undefined {
  const raw = payload.context.rawPayloadSnapshot;
  const direct = firstString(raw['messageId'], raw['message_id'], record(raw['message'])['id'], record(raw['messagePayload'])['id']);
  if (direct !== undefined && /^\d{10,}$/.test(direct)) return direct;
  return MESSAGE_KEY.exec(payload.idempotencyKey)?.[1];
}

/**
 * The team's group id the normalizer captured in `rawPayloadSnapshot.teamId` (from `channelData.team.aadGroupId`).
 * `channelData.team.id` is the General channel's thread id, not a group id, so it is never read here.
 */
export function teamIdOf(payload: CanonicalIncidentPayload): string | undefined {
  const raw = payload.context.rawPayloadSnapshot;
  return firstString(raw['teamId']);
}

function isDirect(payload: CanonicalIncidentPayload, teamId: string | undefined): boolean {
  const raw = payload.context.rawPayloadSnapshot;
  const kind = firstString(raw['conversationType'], record(raw['conversation'])['conversationType']);
  return kind === 'personal' || (teamId === undefined && !payload.context.channelId.includes('@thread.'));
}

/**
 * A personal-chat message has no Graph read; the activity the adapter normalized is the message. Its own
 * attachments are the only URLs the bot token may go to; a hosted content in them must name this message
 * (`at` is where it lives; a personal chat has no team, so none does).
 */
function directMessage(payload: CanonicalIncidentPayload, at?: MessagePlace, parentId?: string): SourceMessage {
  const raw = payload.context.rawPayloadSnapshot;
  const attachments: Attachment[] = [];
  const list = raw['attachments'];
  const messageId = anchorIdOf(payload) ?? firstString(raw['activityId'], raw['id']) ?? payload.eventId;
  for (const item of Array.isArray(list) ? list : []) {
    const a = record(item);
    const contentType = firstString(a['contentType']) ?? '';
    const url = firstString(a['contentUrl'], record(a['content'])['downloadUrl']);
    if (url === undefined) continue;
    if (hostedPartsOf(url) !== undefined && !namesMessage(url, at, messageId, parentId)) continue;
    const mimeType = contentType.includes('/') && !contentType.startsWith('application/vnd.microsoft.teams') ? contentType : extensionType(firstString(a['name']) ?? new URL(url).pathname);
    attachments.push({ kind: mimeType?.startsWith('image/') === true ? 'image' : 'file', url, ...(mimeType === undefined ? {} : { mimeType }) });
  }
  return {
    id: messageId,
    authorId: (payload.anchorAuthor ?? payload.reporter).id,
    text: payload.anchorText,
    timestamp: new Date(firstString(raw['timestamp']) ?? payload.timestamp).toISOString(),
    mentions: [],
    reactions: [],
    attachments,
  };
}

function sniffImage(bytes: Uint8Array): ImageMimeType | undefined {
  const at = (i: number): number => bytes[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return 'image/gif';
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45) return 'image/webp';
  return undefined;
}

const looksLikeHtml = (bytes: Uint8Array): boolean => /^\s*<(?:!doctype|html|\?xml)/i.test(Buffer.from(bytes.subarray(0, 64)).toString('utf8'));

// `.../teams/{team}/channels/{channel}/messages/{message}[/replies/{reply}]/hostedContents/{id}/$value`
const HOSTED_CONTENT = /\/teams\/[^/]+\/channels\/[^/]+\/messages\/[^/]+(?:\/replies\/[^/]+)?\/hostedContents\/[^/]+\/\$value$/;
const HOSTED_PARTS =
  /\/teams\/([^/]+)\/channels\/([^/]+)\/messages\/([^/]+)(?:\/replies\/([^/]+))?\/hostedContents\/([^/]+)\/\$value$/;

/**
 * A downloader for an attachment URL: Graph for a hosted content (inline image) or a SharePoint file,
 * the bot token for a Bot Connector attachment (`.../v3/attachments/{id}/views/{view}`) on an exact Bot
 * Connector host. Undefined for anything else: the token never goes to a host or a path outside that list.
 */
function createDownloader(graph: TeamsGraph, options: TeamsContextSourceOptions): (url: string) => Promise<Uint8Array | undefined> {
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const botHosts = teamsServiceHosts(options.botHosts);
  return async (url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    if (parsed.protocol !== 'https:') return undefined;
    const hosted = parsed.origin === GRAPH_ORIGIN ? HOSTED_PARTS.exec(parsed.pathname) : null;
    if (hosted !== null) {
      const [, team, channel, message, reply, content] = hosted.map((p) => (p === undefined ? p : decodeURIComponent(p)));
      if (team === undefined || channel === undefined || message === undefined || content === undefined) return undefined;
      return graph.hostedContent(team, channel, message, content, reply);
    }
    if (parsed.hostname.endsWith('.sharepoint.com')) return graph.downloadAttachment(url);
    if (!onTeamsServiceHost(parsed, botHosts) || !BOT_ATTACHMENT_PATH.test(parsed.pathname) || parsed.username !== '' || parsed.password !== '') return undefined;
    if (options.botToken === undefined) return undefined;
    const res = await doFetch(url, { headers: { Authorization: `Bearer ${await options.botToken()}`, Accept: '*/*' }, redirect: 'error' });
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : undefined;
  };
}

/**
 * Downloads an image attachment (main 15.2): an inline image through Graph hosted contents, a channel
 * file through Graph (SharePoint), a personal-chat file with the bot token. Returns undefined for
 * anything that is not a readable image, including a 403 (the grant is missing).
 */
export function createTeamsImageLoader(graph: TeamsGraph, options: TeamsContextSourceOptions = {}): LoadImage {
  const download = createDownloader(graph, options);
  return async (attachment) => {
    if (attachment.kind !== 'image') return undefined;
    try {
      const bytes = await download(attachment.url);
      if (bytes === undefined || bytes.length === 0 || looksLikeHtml(bytes)) return undefined;
      const declared = attachment.mimeType !== undefined && IMAGE_TYPES.includes(attachment.mimeType) ? attachment.mimeType : undefined;
      const mimeType = sniffImage(bytes) ?? declared;
      if (mimeType === undefined) return undefined;
      return { mimeType: mimeType as ImageMimeType, data: Buffer.from(bytes).toString('base64'), ref: attachment.url };
    } catch {
      return undefined;
    }
  };
}

/** The same path as the image loader, for a video attachment (A 5.1); a sign-in page is not a recording. */
export function createTeamsRecordingLoader(graph: TeamsGraph, options: TeamsContextSourceOptions = {}): LoadRecording {
  const download = createDownloader(graph, options);
  return async (attachment) => {
    if (attachment.kind !== 'file' || attachment.mimeType?.toLowerCase().startsWith('video/') !== true) return undefined;
    try {
      const bytes = await download(attachment.url);
      return bytes === undefined || bytes.length === 0 || looksLikeHtml(bytes) ? undefined : bytes;
    } catch {
      return undefined;
    }
  };
}

export function createTeamsContextSource(graph: TeamsGraph, options: TeamsContextSourceOptions = {}): TeamsContextSource {
  // A team learned from an activity applies to its channel for the reads that follow.
  const learned = new Map<string, string>();
  const teamFor = (channelId: string): string | undefined => options.teamFor?.(channelId) ?? learned.get(channelId);
  const reader = createTeamsChatReader(graph, { teamFor });
  const resolveTeam = (payload: CanonicalIncidentPayload): string | undefined => {
    const team = teamIdOf(payload) ?? teamFor(payload.context.channelId);
    if (team !== undefined) learned.set(payload.context.channelId, team);
    return team;
  };
  const fetchAnchor = (teamId: string, channelId: string, id: string, parent: string | undefined): Promise<GraphMessage> =>
    parent === undefined || parent === id ? graph.message(teamId, channelId, id) : graph.message(teamId, channelId, parent, id);
  const parentOf = (payload: CanonicalIncidentPayload): string | undefined =>
    payload.context.threadId ?? firstString(payload.context.rawPayloadSnapshot['replyToId']);
  return {
    reader,
    loadImage: createTeamsImageLoader(graph, options),
    loadRecording: createTeamsRecordingLoader(graph, options),

    async anchor(payload): Promise<Anchor> {
      const channelId = payload.context.channelId;
      const teamId = resolveTeam(payload);
      if (isDirect(payload, teamId) || teamId === undefined) return { channelId, message: directMessage(payload), direct: true };
      const id = anchorIdOf(payload);
      if (id === undefined) throw new GraphApiError(0, 'AnchorMissing', 'the payload names no Teams message');
      const parent = parentOf(payload);
      const at = { teamId, channelId };
      try {
        return { channelId, message: toSourceMessage(await fetchAnchor(teamId, channelId, id, parent), at) };
      } catch (err) {
        // No RSC grant: the activity itself is the message (main 15.2), with nothing around it.
        if (err instanceof GraphPermissionError) return { channelId, message: directMessage(payload, at, parent) };
        throw err;
      }
    },

    async limitation(payload): Promise<ContextLimitation | undefined> {
      const teamId = resolveTeam(payload);
      if (teamId === undefined) return isDirect(payload, teamId) ? undefined : 'anchor-only';
      if (isDirect(payload, teamId)) return undefined;
      const id = anchorIdOf(payload);
      if (id === undefined) return undefined;
      try {
        await fetchAnchor(teamId, payload.context.channelId, id, parentOf(payload));
        return undefined;
      } catch (err) {
        return err instanceof GraphPermissionError ? 'anchor-only' : undefined;
      }
    },
  };
}
