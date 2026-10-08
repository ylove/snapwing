// Teams normalization (main 15.2, 14.2; ADR 0019). Three triggers become a CanonicalIncidentPayload with
// `source: 'teams'`; anything else is a typed `ignored` result so the transport can acknowledge it:
//
//   - the message extension action command ("Fix it from here" on a message's "..." menu), as the
//     `composeExtension/fetchTask` or `composeExtension/submitAction` invoke carrying `messagePayload`;
//   - a message in the bot's personal chat (text, file attachments, inline images);
//   - a trigger reaction on a person's channel message, found by the Graph diff (the signals module,
//     #392, hands it over as a `TeamsReactionTrigger`; Bot Framework only reports reactions on the
//     bot's own messages).
//
// People are keyed by their AAD object id (`from.aadObjectId`, Graph's `user.id`), never the `29:` id,
// so the map's `teamsId`, the engineer queue, and the status audience match. Their email comes from
// Graph by that id (`mail`, else the UPN), never from concatenating a name and a domain (main 15.2);
// the map's email is the fallback when Graph cannot say. The `29:` id stays in the snapshot for the
// conversation calls that need it.
//
// Idempotency keys (main 14.2): `teams-{conversationId}-{activityId}`, where the conversation is the
// channel (the `;messageid=` suffix dropped) or the chat, and the activity is the anchor message; a
// reaction trigger appends `-{reaction}`, as Slack's emoji trigger does.
//
// Who triggers counts, as on Slack (`triggerCap`): a person is a member, a guest (`userType` Guest, or an
// `#EXT#` guest account), or external (an activity from another tenant than the install's, or a Graph
// lookup that failed or was not given: fail closed). With no member among the people who triggered, the
// payload carries `levelCap`, so the level is at most 1.

import type { CanonicalIncidentPayload, IncidentActor, LevelCap } from '@snapwing/pipeline/contracts/incident.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { triggerCap, type Membership } from '@snapwing/pipeline/policy/autonomy.ts';
import { ulid } from '@snapwing/pipeline/util/ulid.ts';
import { splitConversationId, type TeamsConversationType } from './conversations.ts';
import type { GraphMessage } from './graph.ts';

/** The action command's id in the Teams app manifest (#389 declares it). */
export const TEAMS_ACTION_COMMAND_ID = 'fixItFromHere';

export const TEAMS_FETCH_TASK = 'composeExtension/fetchTask';
export const TEAMS_SUBMIT_ACTION = 'composeExtension/submitAction';

const FILE_DOWNLOAD_INFO = 'application/vnd.microsoft.teams.file.download.info';
const IMAGE_FILE_TYPES = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'heic', 'heif', 'tif', 'tiff']);

/** A person as Graph knows them (`GET /users/{aadObjectId}`). */
export interface TeamsUserInfo {
  displayName?: string;
  userPrincipalName?: string;
  mail?: string;
  /** `Guest` for a guest account. */
  userType?: string;
}

/**
 * A trigger reaction found by the Graph diff (#392). `reaction` is already the playbook's `teams` name
 * (`bug`), mapped from Graph's `reactionType` by the signals module's table.
 */
export interface TeamsReactionTrigger {
  /** The team's group id. */
  teamId: string;
  /** The channel's id (`19:...@thread.tacv2`). */
  channelId: string;
  /** The reacted-to message as Graph returned it (a root post or a reply, whose `replyToId` is its root). */
  message: GraphMessage;
  reaction: string;
  /** AAD object id of the person whose reaction this is. */
  reactorAadId: string;
  /** AAD object ids of everyone whose reaction of this kind is on the message now (for `minReactors`). */
  reactors?: readonly string[];
  /** ISO 8601 time of the reaction; default the message's last modification. */
  at?: string;
}

/** What the adapter normalizes: a Bot Framework activity, or a reaction trigger the signals module found. */
export type TeamsNormalizeInput = { kind: 'activity'; activity: unknown } | { kind: 'reaction'; trigger: TeamsReactionTrigger };

export interface TeamsNormalizeContext {
  map: WorkspaceMap;
  /** The bot's Microsoft app id; its own messages (`28:{appId}`) and reactions are ignored. */
  botAppId: string;
  /** Graph user lookup by AAD object id; undefined when Graph cannot say. Absent: the map alone. */
  userOf?: (aadObjectId: string) => Promise<TeamsUserInfo | undefined>;
  /** The install's tenant (`TEAMS_TENANT_ID`); an activity from another tenant is external. Absent: not compared. */
  tenantId?: string;
  /** The action command's id; default `TEAMS_ACTION_COMMAND_ID`. */
  commandId?: string;
  newEventId?: (nowMs: number) => string;
}

export type TeamsIgnoreReason =
  | 'unsupported-activity'
  | 'malformed'
  | 'unknown-command'
  | 'not-a-message-command'
  | 'not-a-personal-chat'
  | 'own-message'
  | 'bot-message'
  | 'empty-message'
  | 'direct-message-disabled'
  | 'own-reaction'
  | 'deleted-message'
  | 'not-a-trigger-emoji'
  | 'below-min-reactors';

export type TeamsNormalizeResult =
  | { kind: 'incident'; payload: CanonicalIncidentPayload }
  | { kind: 'ignored'; reason: TeamsIgnoreReason };

/** An image the context reader downloads (#378): an inline image (hosted content or a chat attachment) or a file. */
export interface TeamsSnapshotFile {
  kind: 'inline' | 'file';
  url: string;
  contentType?: string;
  name?: string;
}

export type TeamsTriggerKind = 'action-command' | 'personal-message' | 'reaction';

/** `rawPayloadSnapshot` of a Teams payload: what the adapter and the reader need to talk back and read. */
export interface TeamsSnapshot {
  type: TeamsTriggerKind;
  conversationType: TeamsConversationType;
  /** The channel's id, or the chat's conversation id (also `context.channelId`). */
  channelId: string;
  /** The anchor message's id. */
  anchorId: string;
  /** A channel message's thread root (the anchor itself for a root post). */
  threadRootId?: string;
  teamId?: string;
  tenantId?: string;
  /** The serviceUrl of the activity, when one carried the trigger (a reaction trigger has none). */
  serviceUrl?: string;
  /** The activity id of the invoke or message that brought the report in. */
  activityId?: string;
  /** The reporter's Teams (`29:`) id, for conversation calls. */
  reporterTeamsId?: string;
  reporterUpn?: string;
  anchorAuthorUpn?: string;
  invoke?: string;
  commandId?: string;
  reaction?: string;
  reactors?: string[];
  files: TeamsSnapshotFile[];
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {};
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function arr(v: unknown): Rec[] {
  return Array.isArray(v) ? v.map(rec) : [];
}
const ignored = (reason: TeamsIgnoreReason): TeamsNormalizeResult => ({ kind: 'ignored', reason });

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * A Teams message body (HTML) as plain text: `<at>Name</at>` as `@Name`, line breaks for `<br>` and
 * block ends, images and every other tag dropped, entities decoded.
 */
export function teamsHtmlToText(html: string): string {
  const text = html
    .replace(/<at\b[^>]*>(.*?)<\/at>/gis, (_m, name: string) => `@${name}`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The `src` of every `<img>` in an HTML body (hosted contents and chat attachments). */
function inlineImages(html: string): TeamsSnapshotFile[] {
  const out: TeamsSnapshotFile[] = [];
  for (const m of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const url = decodeEntities(m[2] ?? m[3] ?? '');
    if (url.startsWith('https://') && !out.some((f) => f.url === url)) out.push({ kind: 'inline', url });
  }
  return out;
}

/** Image attachments: inline chat images (`image/*` with a `contentUrl`) and uploaded image files. */
function imageAttachments(attachments: readonly Rec[]): TeamsSnapshotFile[] {
  const out: TeamsSnapshotFile[] = [];
  for (const a of attachments) {
    const contentType = str(a['contentType']);
    const name = str(a['name']);
    if (contentType.startsWith('image/')) {
      const url = str(a['contentUrl']);
      if (url !== '') out.push({ kind: 'inline', url, contentType, ...(name === '' ? {} : { name }) });
    } else if (contentType === FILE_DOWNLOAD_INFO || contentType === 'reference') {
      const content = rec(a['content']);
      const fileType = (str(content['fileType']) || (name.split('.').pop() ?? '')).toLowerCase();
      if (!IMAGE_FILE_TYPES.has(fileType)) continue;
      const url = str(content['downloadUrl']) || str(a['contentUrl']);
      if (url !== '') out.push({ kind: 'file', url, contentType: `image/${fileType === 'jpg' ? 'jpeg' : fileType}`, ...(name === '' ? {} : { name }) });
    }
  }
  return out;
}

function mergeFiles(...lists: TeamsSnapshotFile[][]): TeamsSnapshotFile[] {
  const out: TeamsSnapshotFile[] = [];
  for (const f of lists.flat()) if (!out.some((x) => x.url === f.url)) out.push(f);
  return out;
}

/** A person by AAD object id: the map's handle and role, Graph's email (mail, else UPN), the map's email as fallback. */
async function actor(ctx: TeamsNormalizeContext, aadObjectId: string, fallbackName: string): Promise<{ actor: IncidentActor; upn?: string }> {
  const person = ctx.map.people.find((p) => p.teamsId === aadObjectId);
  const user = ctx.userOf === undefined ? undefined : await ctx.userOf(aadObjectId);
  const email = user?.mail || user?.userPrincipalName || person?.email;
  const name = person?.handle ?? (user?.displayName || fallbackName || aadObjectId);
  return {
    actor: { id: aadObjectId, name, ...(email === undefined || email === '' ? {} : { email }), role: person?.role ?? 'unknown' },
    ...(user?.userPrincipalName ? { upn: user.userPrincipalName } : {}),
  };
}

/** Member, guest, or external (see the file header). `tenant` is the tenant the activity says the person is in. */
async function membership(ctx: TeamsNormalizeContext, aadObjectId: string, tenant?: string): Promise<Membership> {
  if (ctx.tenantId !== undefined && ctx.tenantId !== '' && tenant !== undefined && tenant !== '' && tenant.toLowerCase() !== ctx.tenantId.toLowerCase()) {
    return 'external';
  }
  let user: TeamsUserInfo | undefined;
  try {
    user = ctx.userOf === undefined ? undefined : await ctx.userOf(aadObjectId);
  } catch {
    user = undefined;
  }
  if (user === undefined) return 'external';
  if (user.userType?.toLowerCase() === 'guest' || /#EXT#/i.test(user.userPrincipalName ?? '')) return 'guest';
  return 'member';
}

/** The cap the people who triggered put on the level: none once one of them is a member. The first is asked first. */
async function triggerCapOf(ctx: TeamsNormalizeContext, people: readonly string[], tenant?: string): Promise<LevelCap | undefined> {
  const seen: Membership[] = [];
  for (const id of people) {
    const m = await membership(ctx, id, id === people[0] ? tenant : undefined);
    seen.push(m);
    if (m === 'member') break;
  }
  return triggerCap(seen);
}

function isOwnId(ctx: TeamsNormalizeContext, id: string): boolean {
  return id !== '' && (id === ctx.botAppId || id === `28:${ctx.botAppId}`);
}

/** Emoji that trigger in a channel, by Teams name: a channel override replaces the workspace list. Value is minReactors. */
export function teamsTriggerEmoji(map: WorkspaceMap, channelId: string): Map<string, number> {
  const override = map.channels.find((c) => c.id === channelId)?.triggerEmoji ?? [];
  const workspace = new Map(map.triggers.emoji.map((e) => [e.teams, e.minReactors ?? 1]));
  if (override.length === 0) return workspace;
  return new Map(override.map((name) => [name, workspace.get(name) ?? 1]));
}

/** A channel message's link, when Teams gave none: `/l/message/{channel}/{message}` with the team and the thread. */
function messageLink(channelId: string, messageId: string, teamId: string | undefined, rootId: string | undefined): string {
  const q = new URLSearchParams();
  if (teamId !== undefined) q.set('groupId', teamId);
  if (rootId !== undefined && rootId !== messageId) q.set('parentMessageId', rootId);
  const query = q.toString();
  return `https://teams.microsoft.com/l/message/${encodeURIComponent(channelId)}/${encodeURIComponent(messageId)}${query === '' ? '' : `?${query}`}`;
}

function isoOr(...candidates: string[]): string {
  for (const c of candidates) if (c !== '' && Number.isFinite(Date.parse(c))) return new Date(c).toISOString();
  return new Date(0).toISOString();
}

function build(
  ctx: TeamsNormalizeContext,
  parts: {
    key: string;
    reporter: IncidentActor;
    anchorAuthor?: IncidentActor;
    levelCap?: LevelCap;
    anchorText: string;
    timestamp: string;
    deepLink?: string;
    snapshot: TeamsSnapshot;
  },
): CanonicalIncidentPayload {
  const { snapshot } = parts;
  const threadId = snapshot.threadRootId !== undefined && snapshot.threadRootId !== snapshot.anchorId ? snapshot.threadRootId : undefined;
  return {
    eventId: (ctx.newEventId ?? ulid)(Date.parse(parts.timestamp)),
    idempotencyKey: parts.key,
    source: 'teams',
    reporter: parts.reporter,
    ...(parts.anchorAuthor === undefined ? {} : { anchorAuthor: parts.anchorAuthor }),
    ...(parts.levelCap === undefined ? {} : { levelCap: parts.levelCap }),
    anchorText: parts.anchorText,
    context: {
      channelId: snapshot.channelId,
      ...(threadId === undefined ? {} : { threadId }),
      ...(parts.deepLink === undefined ? {} : { deepLink: parts.deepLink }),
      rawPayloadSnapshot: { ...snapshot } as Record<string, unknown>,
    },
    timestamp: parts.timestamp,
  };
}

/** The snapshot of a Teams payload, read back (the adapter and the reader use it). */
export function teamsSnapshotOf(payload: Pick<CanonicalIncidentPayload, 'context'>): TeamsSnapshot {
  const s = payload.context.rawPayloadSnapshot;
  const type = str(s['type']);
  const conversationType = str(s['conversationType']);
  const out: TeamsSnapshot = {
    type: type === 'personal-message' || type === 'reaction' ? type : 'action-command',
    conversationType: conversationType === 'personal' || conversationType === 'groupChat' ? conversationType : 'channel',
    channelId: str(s['channelId']) || payload.context.channelId,
    anchorId: str(s['anchorId']),
    files: arr(s['files']).flatMap((f): TeamsSnapshotFile[] => {
      const url = str(f['url']);
      const contentType = str(f['contentType']);
      const name = str(f['name']);
      if (url === '') return [];
      return [{ kind: f['kind'] === 'file' ? 'file' : 'inline', url, ...(contentType === '' ? {} : { contentType }), ...(name === '' ? {} : { name }) }];
    }),
  };
  const keys = [
    'threadRootId', 'teamId', 'tenantId', 'serviceUrl', 'activityId', 'reporterTeamsId', 'reporterUpn', 'anchorAuthorUpn', 'invoke', 'commandId', 'reaction',
  ] as const;
  for (const k of keys) {
    const v = str(s[k]);
    if (v !== '') out[k] = v;
  }
  if (Array.isArray(s['reactors'])) out.reactors = s['reactors'].map(str).filter((r) => r !== '');
  return out;
}

/** Normalize a Teams activity, or a reaction trigger from the Graph diff. */
export async function normalizeTeams(input: TeamsNormalizeInput, ctx: TeamsNormalizeContext): Promise<TeamsNormalizeResult> {
  if (input.kind === 'reaction') return reaction(input.trigger, ctx);
  const activity = rec(input.activity);
  const type = str(activity['type']);
  const name = str(activity['name']);
  if (type === 'invoke' && (name === TEAMS_FETCH_TASK || name === TEAMS_SUBMIT_ACTION)) return actionCommand(activity, name, ctx);
  if (type === 'message') return personalMessage(activity, ctx);
  return ignored('unsupported-activity');
}

function conversationOf(activity: Rec, ctx: TeamsNormalizeContext) {
  const conversation = rec(activity['conversation']);
  const conversationId = str(conversation['id']);
  const channelData = rec(activity['channelData']);
  const rawType = str(conversation['conversationType']);
  const channelFromData = str(rec(channelData['channel'])['id']);
  const conversationType: TeamsConversationType =
    rawType === 'personal' || rawType === 'groupChat' || rawType === 'channel' ? rawType : channelFromData === '' ? 'personal' : 'channel';
  const split = splitConversationId(conversationId);
  const channelId = conversationType === 'channel' ? channelFromData || split.channelId : conversationId;
  const mapTeam = ctx.map.channels.find((c) => c.id === channelId)?.teamId;
  const teamId = str(rec(channelData['team'])['aadGroupId']) || mapTeam || '';
  const tenantId = str(rec(channelData['tenant'])['id']) || str(conversation['tenantId']);
  return {
    conversationId,
    conversationType,
    channelId,
    splitRoot: split.threadRootId,
    ...(teamId === '' || conversationType !== 'channel' ? {} : { teamId }),
    ...(tenantId === '' ? {} : { tenantId }),
  };
}

async function actionCommand(activity: Rec, invoke: string, ctx: TeamsNormalizeContext): Promise<TeamsNormalizeResult> {
  const value = rec(activity['value']);
  const commandId = str(value['commandId']);
  if (commandId !== (ctx.commandId ?? TEAMS_ACTION_COMMAND_ID)) return ignored('unknown-command');
  const message = rec(value['messagePayload']);
  const anchorId = str(message['id']);
  if (str(value['commandContext']) !== 'message' || anchorId === '') return ignored('not-a-message-command');
  const from = rec(activity['from']);
  const invokerAad = str(from['aadObjectId']);
  const conv = conversationOf(activity, ctx);
  if (invokerAad === '' || conv.conversationId === '') return ignored('malformed');

  const rootId = conv.conversationType === 'channel' ? str(message['replyToId']) || conv.splitRoot || anchorId : undefined;
  const reporter = await actor(ctx, invokerAad, str(from['name']));
  const levelCap = await triggerCapOf(ctx, [invokerAad], conv.tenantId);

  // The anchor's author, when a person other than the invoker wrote it (#363); a bot's post has none.
  const author = rec(message['from']);
  const authorUser = rec(author['user']);
  const authorAad = str(authorUser['id']);
  const byPerson = authorAad !== '' && Object.keys(rec(author['application'])).length === 0 && str(authorUser['userIdentityType']) !== 'bot';
  const anchorAuthor = byPerson && authorAad !== invokerAad ? await actor(ctx, authorAad, str(authorUser['displayName'])) : undefined;

  const body = rec(message['body']);
  const content = str(body['content']);
  const anchorText = str(body['contentType']) === 'text' ? content.trim() : teamsHtmlToText(content);
  const files = mergeFiles(str(body['contentType']) === 'text' ? [] : inlineImages(content), imageAttachments(arr(message['attachments'])));
  const link =
    str(message['linkToMessage']) ||
    (conv.conversationType === 'channel' ? messageLink(conv.channelId, anchorId, conv.teamId, rootId) : '');
  const serviceUrl = str(activity['serviceUrl']);
  const activityId = str(activity['id']);
  return {
    kind: 'incident',
    payload: build(ctx, {
      key: `teams-${conv.channelId}-${anchorId}`,
      reporter: reporter.actor,
      ...(anchorAuthor === undefined ? {} : { anchorAuthor: anchorAuthor.actor }),
      ...(levelCap === undefined ? {} : { levelCap }),
      anchorText,
      timestamp: isoOr(str(message['createdDateTime']), str(activity['timestamp'])),
      ...(link === '' ? {} : { deepLink: link }),
      snapshot: {
        type: 'action-command',
        conversationType: conv.conversationType,
        channelId: conv.channelId,
        anchorId,
        ...(rootId === undefined ? {} : { threadRootId: rootId }),
        ...(conv.teamId === undefined ? {} : { teamId: conv.teamId }),
        ...(conv.tenantId === undefined ? {} : { tenantId: conv.tenantId }),
        ...(serviceUrl === '' ? {} : { serviceUrl }),
        ...(activityId === '' ? {} : { activityId }),
        ...(str(from['id']) === '' ? {} : { reporterTeamsId: str(from['id']) }),
        ...(reporter.upn === undefined ? {} : { reporterUpn: reporter.upn }),
        ...(anchorAuthor?.upn === undefined ? {} : { anchorAuthorUpn: anchorAuthor.upn }),
        invoke,
        commandId,
        files,
      },
    }),
  };
}

async function personalMessage(activity: Rec, ctx: TeamsNormalizeContext): Promise<TeamsNormalizeResult> {
  const conv = conversationOf(activity, ctx);
  if (conv.conversationType !== 'personal') return ignored('not-a-personal-chat');
  const from = rec(activity['from']);
  const fromId = str(from['id']);
  if (isOwnId(ctx, fromId)) return ignored('own-message');
  if (fromId.startsWith('28:') || str(from['role']) === 'bot') return ignored('bot-message');
  const aad = str(from['aadObjectId']);
  const activityId = str(activity['id']);
  if (aad === '' || activityId === '' || conv.conversationId === '') return ignored('malformed');

  const rawText = str(activity['text']);
  const text = /<[a-z!/][^>]*>/i.test(rawText) || str(activity['textFormat']) === 'xml' ? teamsHtmlToText(rawText) : rawText.trim();
  const attachments = arr(activity['attachments']);
  const htmlBodies = attachments.filter((a) => str(a['contentType']) === 'text/html').map((a) => str(a['content']));
  const images = mergeFiles(imageAttachments(attachments), ...htmlBodies.map(inlineImages));
  const hasText = text !== '';
  if (!hasText && images.length === 0) return ignored('empty-message');
  const dm = ctx.map.triggers.directMessage;
  if (dm !== undefined && ((hasText && !dm.text && images.length === 0) || (images.length > 0 && !dm.images && !hasText))) {
    return ignored('direct-message-disabled');
  }
  const reporter = await actor(ctx, aad, str(from['name']));
  const levelCap = await triggerCapOf(ctx, [aad], conv.tenantId);
  const serviceUrl = str(activity['serviceUrl']);
  return {
    kind: 'incident',
    payload: build(ctx, {
      key: `teams-${conv.conversationId}-${activityId}`,
      reporter: reporter.actor,
      ...(levelCap === undefined ? {} : { levelCap }),
      anchorText: text,
      timestamp: isoOr(str(activity['timestamp']), str(activity['localTimestamp'])),
      snapshot: {
        type: 'personal-message',
        conversationType: 'personal',
        channelId: conv.conversationId,
        anchorId: activityId,
        ...(conv.tenantId === undefined ? {} : { tenantId: conv.tenantId }),
        ...(serviceUrl === '' ? {} : { serviceUrl }),
        activityId,
        reporterTeamsId: fromId,
        ...(reporter.upn === undefined ? {} : { reporterUpn: reporter.upn }),
        files: images,
      },
    }),
  };
}

async function reaction(trigger: TeamsReactionTrigger, ctx: TeamsNormalizeContext): Promise<TeamsNormalizeResult> {
  const { message } = trigger;
  if (isOwnId(ctx, trigger.reactorAadId)) return ignored('own-reaction');
  if (trigger.channelId === '' || trigger.reactorAadId === '' || message.id === '') return ignored('malformed');
  if (message.deletedDateTime !== undefined && message.deletedDateTime !== null) return ignored('deleted-message');
  const min = teamsTriggerEmoji(ctx.map, trigger.channelId).get(trigger.reaction);
  if (min === undefined) return ignored('not-a-trigger-emoji');
  const reactors = new Set<string>([trigger.reactorAadId]);
  for (const r of trigger.reactors ?? []) if (r !== '' && !isOwnId(ctx, r)) reactors.add(r);
  if (reactors.size < min) return ignored('below-min-reactors');

  const reporter = await actor(ctx, trigger.reactorAadId, '');
  const levelCap = await triggerCapOf(ctx, [...reactors]);
  const authorUser = message.from?.user ?? undefined;
  const byPerson = authorUser !== undefined && (message.from?.application ?? undefined) === undefined && authorUser.userIdentityType !== 'bot';
  const anchorAuthor =
    byPerson && authorUser.id !== trigger.reactorAadId ? await actor(ctx, authorUser.id, authorUser.displayName ?? '') : undefined;

  const content = message.body?.content ?? '';
  const html = message.body?.contentType !== 'text';
  const anchorText = html ? teamsHtmlToText(content) : content.trim();
  const rootId = message.replyToId ?? message.id;
  const files = mergeFiles(
    html ? inlineImages(content) : [],
    imageAttachments((message.attachments ?? []).map((a) => ({ ...a }) as Rec)),
  );
  return {
    kind: 'incident',
    payload: build(ctx, {
      key: `teams-${trigger.channelId}-${message.id}-${trigger.reaction}`,
      reporter: reporter.actor,
      ...(anchorAuthor === undefined ? {} : { anchorAuthor: anchorAuthor.actor }),
      ...(levelCap === undefined ? {} : { levelCap }),
      anchorText,
      timestamp: isoOr(trigger.at ?? '', message.lastModifiedDateTime ?? '', message.createdDateTime),
      deepLink: message.webUrl ?? messageLink(trigger.channelId, message.id, trigger.teamId, rootId),
      snapshot: {
        type: 'reaction',
        conversationType: 'channel',
        channelId: trigger.channelId,
        anchorId: message.id,
        threadRootId: rootId,
        teamId: trigger.teamId,
        ...(reporter.upn === undefined ? {} : { reporterUpn: reporter.upn }),
        ...(anchorAuthor?.upn === undefined ? {} : { anchorAuthorUpn: anchorAuthor.upn }),
        reaction: trigger.reaction,
        reactors: [...reactors],
        files,
      },
    }),
  };
}
