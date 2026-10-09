// Teams channel members for the notification policy (A 4.4, #10). A watcher who is in the incident's
// channel is mentioned in the thread; anyone else gets a personal message. The policy reads the member
// list from kv `channel-members:{channel}` (`channelMembersKey`, a JSON array of user ids) inside the
// append; this module writes it, as `adapters/slack/channel-members.ts` does for Slack.
//
// - A member is the AAD object id Graph gives as `userId`, the map's `teamsId`.
// - `refresh(channel)` reads the channel's members from Graph (`GET /teams/{team}/channels/{id}/members`)
//   and writes the list with a TTL (`CHANNEL_MEMBERS_TTL_SEC`), so a list nobody refreshes expires and the
//   policy falls back to mentioning everyone in the thread.
// - `refreshAll()` refreshes every Teams channel the map names; compose runs it at worker start and every
//   `CHANNEL_MEMBERS_REFRESH_MS`.
//
// A channel Graph will not list (no member-read grant: a 403, a channel that no longer exists: a 404, a
// map channel with no team id) is skipped and reported once through `onSkip` (an info log), never as an
// error: the key stays unwritten and the policy keeps its default. Any other failure goes to `onError`.

import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { channelPlatform } from '@snapwing/pipeline/map/types.ts';
import type { CachePort } from '@snapwing/pipeline/ports/cache.ts';
import { channelMembersKey } from '@snapwing/pipeline/state/projections/notify-context.ts';
import { briefMembers, type StatusAccess } from '@snapwing/pipeline/status/ask.ts';
import { CHANNEL_MEMBERS_REFRESH_MS, CHANNEL_MEMBERS_TTL_SEC } from '../slack/channel-members.ts';
import { GraphApiError, GraphPermissionError, type GraphMember, type TeamsGraph } from './graph.ts';

export { CHANNEL_MEMBERS_REFRESH_MS, CHANNEL_MEMBERS_TTL_SEC };

export interface TeamsChannelMembersOptions {
  graph: Pick<TeamsGraph, 'channelMembers'>;
  cache: CachePort;
  getMap: () => Promise<WorkspaceMap>;
  /** A channel Graph would not list, with the reason (`missing-grant`, `not-found`, `no-team`). */
  onSkip?: (channel: string, reason: string) => void;
  onError?: (error: unknown) => void;
}

export type TeamsChannelMembersOutcome =
  | { kind: 'refreshed'; channel: string; members: number }
  | { kind: 'skipped'; channel: string; reason: string };

export interface TeamsChannelMembers {
  /** Reads the channel's members from Graph and writes the kv list. `channel` is the map channel's id. */
  refresh(channel: string): Promise<TeamsChannelMembersOutcome>;
  /** Refreshes every Teams channel the map names; one failing channel does not stop the rest. */
  refreshAll(): Promise<TeamsChannelMembersOutcome[]>;
}

export function createTeamsChannelMembers(options: TeamsChannelMembersOptions): TeamsChannelMembers {
  const { graph, cache } = options;
  const onError = options.onError ?? (() => undefined);
  const skippedOnce = new Set<string>();

  function skip(channel: string, reason: string): TeamsChannelMembersOutcome {
    const key = `${channel}:${reason}`;
    if (!skippedOnce.has(key)) {
      skippedOnce.add(key);
      options.onSkip?.(channel, reason);
    }
    return { kind: 'skipped', channel, reason };
  }

  async function refresh(channel: string): Promise<TeamsChannelMembersOutcome> {
    const map = await options.getMap();
    const mapped = map.channels.find((c) => c.id === channel && channelPlatform(c) === 'teams');
    if (mapped?.teamId === undefined || mapped.teamId === '') return skip(channel, 'no-team');
    let found: GraphMember[];
    try {
      found = await graph.channelMembers(mapped.teamId, channel);
    } catch (e) {
      if (e instanceof GraphPermissionError) return skip(channel, 'missing-grant');
      if (e instanceof GraphApiError && e.status === 404) return skip(channel, 'not-found');
      throw e;
    }
    const list = [...new Set(found.map((m) => m.userId).filter((u): u is string => typeof u === 'string' && u !== ''))].sort();
    await cache.set(channelMembersKey(channel), JSON.stringify(list), CHANNEL_MEMBERS_TTL_SEC);
    return { kind: 'refreshed', channel, members: list.length };
  }

  async function refreshAll(): Promise<TeamsChannelMembersOutcome[]> {
    const map = await options.getMap();
    const channels = [...new Set(map.channels.filter((c) => channelPlatform(c) === 'teams' && c.id !== '').map((c) => c.id))];
    const out: TeamsChannelMembersOutcome[] = [];
    for (const channel of channels) {
      try {
        out.push(await refresh(channel));
      } catch (e) {
        onError(e);
      }
    }
    return out;
  }

  return { refresh, refreshAll };
}

/**
 * Who may hear about what on Teams (A 4.3, #272), as `adapters/slack` gives it: a member is whoever
 * Graph names and is not a guest (`userType` Guest or an `#EXT#` account); without a Graph answer
 * (no `User.Read.All`) only a person the map lists. A channel's members come from Graph live, remembered
 * briefly (`briefMembers`); a channel the map gives no team, or Graph will not list, has nobody in it.
 */
export function createTeamsStatusAccess(options: { graph: Pick<TeamsGraph, 'user' | 'channelMembers'>; getMap: () => Promise<WorkspaceMap>; clock?: () => Date }): StatusAccess {
  const { graph } = options;
  return {
    platform: 'teams',
    async membership(aadObjectId) {
      const user = await graph.user(aadObjectId).catch(() => undefined);
      if (user === undefined) return (await options.getMap()).people.some((p) => p.teamsId === aadObjectId) ? 'member' : 'external';
      return user.userType?.toLowerCase() === 'guest' || /#EXT#/i.test(user.userPrincipalName ?? '') ? 'guest' : 'member';
    },
    inChannel: briefMembers(async (channelId) => {
      const team = (await options.getMap()).channels.find((c) => c.id === channelId && channelPlatform(c) === 'teams')?.teamId;
      if (team === undefined || team === '') return [];
      return (await graph.channelMembers(team, channelId)).flatMap((m) => (typeof m.userId === 'string' && m.userId !== '' ? [m.userId] : []));
    }, options.clock),
  };
}
