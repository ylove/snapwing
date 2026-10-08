// Where Snapwing talks back to a Teams conversation, and the team's mode (ADR 0019, ADR 0005).
//
// Every Bot Connector call goes to a `serviceUrl` that only an inbound activity names, and a reaction
// trigger found by the Graph diff carries none. So the adapter keeps one record per conversation in kv
// `teams-conversation:{channelId}` (the channel's id, or the chat's id for a personal or group chat):
// the serviceUrl, tenant, team, the conversation's kind, and the thread root of the activity that last
// refreshed it. Every authenticated inbound activity refreshes it; an incident's own thread root lives
// in its payload, never in this record. No TTL: a serviceUrl rarely moves, and the next activity fixes it.
//
// kv `teams-mode:{teamId}` (the team's group id) is `reduced` while the team owner has not consented to
// the RSC permissions (ADR 0005); every card the adapter posts in such a team carries the reduced-mode
// banner. The mode check (installation and conversation updates, onboarding) and the Graph subscriptions both write
// it through `writeTeamsMode`, as JSON `{ mode, since, retryAt?, reason? }`; absent is `full`.
//
// kv `teams-user:{aadObjectId}` is the same for a person: every authenticated activity they send refreshes
// their `29:` id, serviceUrl, tenant, and the name Teams shows for them (`rememberUser` on the chat
// surface). A personal chat opens with that `29:` id, and a person the map does not list is mentioned by
// that name (`rememberedNames`).

import type { CachePort } from '@snapwing/pipeline/ports/cache.ts';

export type TeamsConversationType = 'channel' | 'groupChat' | 'personal';

export interface TeamsConversationRecord {
  /** The Bot Connector endpoint for this conversation (https, from the activity). */
  serviceUrl: string;
  tenantId?: string;
  /** The team's group id (Graph `teams/{id}`), for a channel. */
  teamId?: string;
  /** The channel's id (`19:...@thread.tacv2`), or the chat's conversation id. The kv key. */
  channelId: string;
  conversationType: TeamsConversationType;
  /** The thread root of the activity that last refreshed the record (channel replies only). */
  threadRootId?: string;
  /** ISO 8601. */
  updatedAt: string;
}

export const teamsConversationKey = (channelId: string): string => `teams-conversation:${channelId}`;
export const teamsModeKey = (teamId: string): string => `teams-mode:${teamId}`;

export type TeamsMode = 'full' | 'reduced';

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {};
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** `19:abc@thread.tacv2;messageid=123` is the channel `19:abc@thread.tacv2` and the thread root `123`. */
export function splitConversationId(conversationId: string): { channelId: string; threadRootId?: string } {
  const [channelId = conversationId, ...rest] = conversationId.split(';');
  const root = rest.map((p) => /^messageid=(.+)$/.exec(p)?.[1]).find((r) => r !== undefined);
  return root === undefined ? { channelId } : { channelId, threadRootId: root };
}

function conversationTypeOf(value: string): TeamsConversationType | undefined {
  return value === 'channel' || value === 'groupChat' || value === 'personal' ? value : undefined;
}

/**
 * The record an inbound activity implies, or undefined when it names no serviceUrl or conversation.
 * The team is the channel data's `aadGroupId` (the group id Graph and the map use), else `fallbackTeamId`.
 */
export function conversationFromActivity(activity: unknown, now: Date, fallbackTeamId?: string): TeamsConversationRecord | undefined {
  const a = rec(activity);
  const serviceUrl = str(a['serviceUrl']);
  const conversation = rec(a['conversation']);
  const conversationId = str(conversation['id']);
  if (serviceUrl === '' || conversationId === '') return undefined;
  const channelData = rec(a['channelData']);
  const type = conversationTypeOf(str(conversation['conversationType'])) ?? (str(rec(channelData['channel'])['id']) === '' ? 'personal' : 'channel');
  const split = splitConversationId(conversationId);
  const channelId = str(rec(channelData['channel'])['id']) || split.channelId;
  const tenantId = str(rec(channelData['tenant'])['id']) || str(conversation['tenantId']);
  const teamId = str(rec(channelData['team'])['aadGroupId']) || (fallbackTeamId ?? '');
  return {
    serviceUrl,
    ...(tenantId === '' ? {} : { tenantId }),
    ...(type === 'channel' && teamId !== '' ? { teamId } : {}),
    channelId,
    conversationType: type,
    ...(type === 'channel' && split.threadRootId !== undefined ? { threadRootId: split.threadRootId } : {}),
    updatedAt: now.toISOString(),
  };
}

export async function rememberTeamsConversation(cache: Pick<CachePort, 'set'>, record: TeamsConversationRecord): Promise<void> {
  await cache.set(teamsConversationKey(record.channelId), JSON.stringify(record));
}

/** The stored record, or undefined when there is none or it does not parse. */
export async function readTeamsConversation(cache: Pick<CachePort, 'get'>, channelId: string): Promise<TeamsConversationRecord | undefined> {
  const raw = await cache.get(teamsConversationKey(channelId));
  if (raw === null) return undefined;
  let parsed: Rec;
  try {
    parsed = rec(JSON.parse(raw));
  } catch {
    return undefined;
  }
  const serviceUrl = str(parsed['serviceUrl']);
  const type = conversationTypeOf(str(parsed['conversationType']));
  if (serviceUrl === '' || type === undefined) return undefined;
  const optional = (k: 'tenantId' | 'teamId' | 'threadRootId') => (str(parsed[k]) === '' ? {} : { [k]: str(parsed[k]) });
  return {
    serviceUrl,
    ...optional('tenantId'),
    ...optional('teamId'),
    channelId,
    conversationType: type,
    ...optional('threadRootId'),
    updatedAt: str(parsed['updatedAt']),
  };
}

// People ------------------------------------------------------------------------------------------

/** What is kept about a person from the last authenticated activity they sent (kv `teams-user:{aadObjectId}`). */
export interface TeamsUserRecord {
  aadObjectId: string;
  /** The `29:` Teams id from `from.id`, when the activity carried one: a personal chat opens with it. */
  teamsUserId?: string;
  /** The name Teams shows for them (`from.name`): how a person outside the map is named, never by a raw id. */
  name?: string;
  serviceUrl: string;
  tenantId?: string;
  updatedAt: string;
}

export const teamsUserKey = (aadObjectId: string): string => `teams-user:${aadObjectId}`;

/** The user record an inbound activity implies, or undefined without an AAD id or a serviceUrl. */
export function userFromActivity(activity: unknown, now: Date): TeamsUserRecord | undefined {
  const a = rec(activity);
  const from = rec(a['from']);
  const aadObjectId = str(from['aadObjectId']);
  const serviceUrl = str(a['serviceUrl']);
  if (aadObjectId === '' || serviceUrl === '') return undefined;
  const fromId = str(from['id']);
  const name = str(from['name']).trim();
  const tenantId = str(rec(rec(a['channelData'])['tenant'])['id']) || str(rec(a['conversation'])['tenantId']);
  return {
    aadObjectId,
    ...(fromId.startsWith('29:') ? { teamsUserId: fromId } : {}),
    ...(name === '' ? {} : { name }),
    serviceUrl,
    ...(tenantId === '' ? {} : { tenantId }),
    updatedAt: now.toISOString(),
  };
}

/** The stored user record, or undefined when there is none or it does not parse. */
export async function readTeamsUser(cache: Pick<CachePort, 'get'>, aadObjectId: string): Promise<TeamsUserRecord | undefined> {
  const raw = await cache.get(teamsUserKey(aadObjectId));
  if (raw === null) return undefined;
  try {
    const p = rec(JSON.parse(raw));
    const serviceUrl = str(p['serviceUrl']);
    if (serviceUrl === '') return undefined;
    const optional = (k: 'teamsUserId' | 'name' | 'tenantId') => (str(p[k]) === '' ? {} : { [k]: str(p[k]) });
    return { aadObjectId, ...optional('teamsUserId'), ...optional('name'), serviceUrl, ...optional('tenantId'), updatedAt: str(p['updatedAt']) };
  } catch {
    return undefined;
  }
}

const AAD_OBJECT_IDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * The names Teams gave the people `text` names by AAD object id, from their user records, for each id
 * `known` (the map) cannot name: so a mention reads `<at>Dana Lee</at>`, never the raw id. An id with no
 * record, or a record with no name, is left out. Best effort: a read that fails names nobody.
 */
export async function rememberedNames(
  cache: Pick<CachePort, 'get'>,
  text: string,
  known: (id: string) => boolean = () => false,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of new Set(text.match(AAD_OBJECT_IDS) ?? [])) {
    if (known(id)) continue;
    const name = (await readTeamsUser(cache, id).catch(() => undefined))?.name;
    if (name !== undefined) out.set(id, name);
  }
  return out;
}

/**
 * What kv `teams-mode:{teamId}` holds, JSON, written only by `writeTeamsMode`: the mode, when it began, and
 * for `reduced` an optional retry time and reason (the Graph subscriptions set both, the RSC mode check neither).
 */
export interface TeamsModeMark {
  mode: TeamsMode;
  /** ISO 8601. */
  since: string;
  /** ISO 8601, reduced only. */
  retryAt?: string;
  reason?: string;
}

/** The stored mark, or undefined when the team has none (absent is `full`). */
export async function readTeamsModeMark(cache: Pick<CachePort, 'get'>, teamId: string): Promise<TeamsModeMark | undefined> {
  const raw = await cache.get(teamsModeKey(teamId));
  if (raw === null || raw === '') return undefined;
  // Rows written before the shared format hold the bare word `full` or `reduced`.
  if (raw === 'full' || raw === 'reduced') return { mode: raw, since: '' };
  let parsed: Rec;
  try {
    parsed = rec(JSON.parse(raw));
  } catch {
    return undefined;
  }
  const mode = parsed['mode'];
  if (mode !== 'full' && mode !== 'reduced') return undefined;
  const retryAt = str(parsed['retryAt']);
  const reason = str(parsed['reason']);
  return { mode, since: str(parsed['since']), ...(retryAt === '' ? {} : { retryAt }), ...(reason === '' ? {} : { reason }) };
}

/** The team's mode; `full` when nothing is stored or the row is unreadable. */
export async function readTeamsMode(cache: Pick<CachePort, 'get'>, teamId: string): Promise<TeamsMode> {
  return (await readTeamsModeMark(cache, teamId))?.mode ?? 'full';
}

/** The one writer of kv `teams-mode:{teamId}`; `since` defaults to now. */
export async function writeTeamsMode(
  cache: Pick<CachePort, 'set'>,
  teamId: string,
  mode: TeamsMode,
  details: { since?: string; retryAt?: string; reason?: string } = {},
): Promise<void> {
  const mark: TeamsModeMark = {
    mode,
    since: details.since ?? new Date().toISOString(),
    ...(mode === 'reduced' && details.retryAt !== undefined ? { retryAt: details.retryAt } : {}),
    ...(mode === 'reduced' && details.reason !== undefined ? { reason: details.reason } : {}),
  };
  await cache.set(teamsModeKey(teamId), JSON.stringify(mark));
}
