// Slack channel members for the notification policy (A 4.4, #329, #337). A watcher who is in the
// incident's channel is mentioned in the thread; anyone else gets a DM. The policy reads the member
// list from kv `channel-members:{channel}` (`channelMembersKey`, a JSON array of user ids) inside the
// append; this module is what writes it.
//
// - `refresh(channel)` reads every page of `conversations.members` and writes the list with a TTL
//   (`CHANNEL_MEMBERS_TTL_SEC`), so a list nobody refreshes expires and the policy falls back to
//   mentioning everyone in the thread, as it did before anything wrote the key.
// - `refreshAll()` refreshes every channel the map names; compose runs it as a worker service at start
//   and every `CHANNEL_MEMBERS_REFRESH_MS`.
// - `member_joined_channel` and `member_left_channel` (`handleEvent`, through `observeChannelMembers`)
//   add or remove the one user when the list is known, and refresh the channel when it is not.
//
// A channel Slack will not list (the app lacks `channels:read` or `groups:read` until the owner
// reinstalls it, a private channel the bot is not in, a channel that no longer exists) is skipped and
// reported once through `onSkip`, never as an error: the key stays unwritten and the policy keeps its
// default. Any other failure goes to `onError`.

import { channelMembersKey } from '@snapwing/pipeline/state/projections/notify-context.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { CachePort } from '@snapwing/pipeline/ports/cache.ts';
import { parsedBodyOf, type SlackAdapter } from './adapter.ts';
import { SlackApiError, type SlackWeb } from './web.ts';

/** How long a written member list is trusted: a missed join or leave event heals within this. */
export const CHANNEL_MEMBERS_TTL_SEC = 6 * 60 * 60;
/** How often the worker refreshes every map channel: well inside the TTL. */
export const CHANNEL_MEMBERS_REFRESH_MS = 2 * 60 * 60 * 1000;
/** Members read per `conversations.members` page. */
const PAGE_LIMIT = 1000;
/** Pages read before giving up on a channel (a 200,000 member channel is not a bug channel). */
const MAX_PAGES = 200;

/** Slack errors that mean "this channel cannot be listed", not "something broke". */
const SKIPPED_ERRORS: ReadonlySet<string> = new Set(['missing_scope', 'not_in_channel', 'channel_not_found', 'method_not_supported_for_channel_type']);

const MEMBER_EVENTS: ReadonlySet<string> = new Set(['member_joined_channel', 'member_left_channel']);

export interface SlackChannelMembersOptions {
  web: Pick<SlackWeb, 'conversationsMembers'>;
  cache: CachePort;
  getMap: () => Promise<WorkspaceMap>;
  /** A channel Slack would not list, with Slack's error code. */
  onSkip?: (channel: string, error: string) => void;
  onError?: (error: unknown) => void;
}

export type ChannelMembersOutcome =
  | { kind: 'ignored'; reason: 'not-a-member-event' | 'malformed' }
  | { kind: 'refreshed'; channel: string; members: number }
  | { kind: 'skipped'; channel: string; error: string }
  | { kind: 'updated'; channel: string; members: number };

export interface SlackChannelMembers {
  /** Reads the channel's members from Slack and writes the kv list. */
  refresh(channel: string): Promise<ChannelMembersOutcome>;
  /** Refreshes every channel the map names; one failing channel does not stop the rest. */
  refreshAll(): Promise<ChannelMembersOutcome[]>;
  /** True for a `member_joined_channel` or `member_left_channel` Events API body. */
  observes(body: unknown): boolean;
  /** Applies one membership event. */
  handleEvent(body: unknown): Promise<ChannelMembersOutcome>;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function createSlackChannelMembers(options: SlackChannelMembersOptions): SlackChannelMembers {
  const { web, cache } = options;
  const onError = options.onError ?? (() => undefined);
  const skippedOnce = new Set<string>();

  async function write(channel: string, members: Iterable<string>): Promise<number> {
    const list = [...new Set(members)].sort();
    await cache.set(channelMembersKey(channel), JSON.stringify(list), CHANNEL_MEMBERS_TTL_SEC);
    return list.length;
  }

  async function refresh(channel: string): Promise<ChannelMembersOutcome> {
    const members: string[] = [];
    let cursor: string | undefined;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const got = await web.conversationsMembers({ channel, limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) });
        members.push(...got.members);
        cursor = got.nextCursor;
        if (cursor === undefined) break;
      }
    } catch (e) {
      if (e instanceof SlackApiError && SKIPPED_ERRORS.has(e.error)) {
        const key = `${channel}:${e.error}`;
        if (!skippedOnce.has(key)) {
          skippedOnce.add(key);
          options.onSkip?.(channel, e.error);
        }
        return { kind: 'skipped', channel, error: e.error };
      }
      throw e;
    }
    return { kind: 'refreshed', channel, members: await write(channel, members) };
  }

  async function refreshAll(): Promise<ChannelMembersOutcome[]> {
    const map = await options.getMap();
    const channels = [...new Set(map.channels.map((c) => c.id).filter((id) => id !== ''))];
    const out: ChannelMembersOutcome[] = [];
    for (const channel of channels) {
      try {
        out.push(await refresh(channel));
      } catch (e) {
        onError(e);
      }
    }
    return out;
  }

  function observes(body: unknown): boolean {
    const outer = rec(body);
    return outer['type'] === 'event_callback' && MEMBER_EVENTS.has(str(rec(outer['event'])['type']));
  }

  async function handleEvent(body: unknown): Promise<ChannelMembersOutcome> {
    if (!observes(body)) return { kind: 'ignored', reason: 'not-a-member-event' };
    const event = rec(rec(body)['event']);
    const channel = str(event['channel']);
    const user = str(event['user']);
    if (channel === '' || user === '') return { kind: 'ignored', reason: 'malformed' };
    const raw = await cache.get(channelMembersKey(channel));
    let known: string[] | undefined;
    try {
      const parsed: unknown = raw === null ? undefined : JSON.parse(raw);
      known = Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === 'string') : undefined;
    } catch {
      known = undefined;
    }
    // Not known yet (or expired): read the whole list rather than write a list of one.
    if (known === undefined) return refresh(channel);
    const members = new Set(known);
    if (str(event['type']) === 'member_joined_channel') members.add(user);
    else members.delete(user);
    return { kind: 'updated', channel, members: await write(channel, members) };
  }

  return { refresh, refreshAll, observes, handleEvent };
}

/**
 * The adapter for `createSlackTransport`, with every membership event also handed to `members`. Like
 * `observeSignals`, it relies on the transport calling `normalizeResult` once per authenticated
 * request. Not awaited; failures go to `onError`.
 */
export function observeChannelMembers(adapter: SlackAdapter, members: Pick<SlackChannelMembers, 'observes' | 'handleEvent'>, onError: (error: unknown) => void = () => undefined): SlackAdapter {
  return {
    ...adapter,
    async normalizeResult(raw) {
      const result = await adapter.normalizeResult(raw);
      const body = parsedBodyOf(raw);
      if (members.observes(body)) void members.handleEvent(body).catch(onError);
      return result;
    },
  };
}
