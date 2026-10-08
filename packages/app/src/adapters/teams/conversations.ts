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
// banner. The mode check (installation and conversation updates, onboarding) writes it; absent is `full`.

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

/**
 * The team's mode. The mode check writes the bare word; the Graph subscriptions (`subscriptions.ts`) write
 * JSON `{ mode, since, ... }` under the same key, and either one marks the team reduced.
 */
export async function readTeamsMode(cache: Pick<CachePort, 'get'>, teamId: string): Promise<TeamsMode> {
  const raw = await cache.get(teamsModeKey(teamId));
  if (raw === null || raw === 'full') return 'full';
  if (raw === 'reduced') return 'reduced';
  try {
    return rec(JSON.parse(raw))['mode'] === 'reduced' ? 'reduced' : 'full';
  } catch {
    return 'full';
  }
}

export async function writeTeamsMode(cache: Pick<CachePort, 'set'>, teamId: string, mode: TeamsMode): Promise<void> {
  await cache.set(teamsModeKey(teamId), mode);
}
