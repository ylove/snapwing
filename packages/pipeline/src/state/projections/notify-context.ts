// What the notification hook needs and the event does not carry (A 4.4, #329): `IncidentChange.notify`
// for `outbox/notify.ts`. Built inside the append transaction, for an event that is a milestone only,
// so an ordinary append reads nothing extra.
//
// - The playbook's `<notifications>`: the cached playbook (`config_versions`, kind `playbook`, put by
//   the config watch after it validates a file); the defaults when none is cached or it does not parse,
//   so watchers and the staging request work on an install with no playbook file.
// - Subscriptions: the incident's (as the log has folded them up to this event), plus the workspace's
//   standing `surface` rows for the incident's surface and `all` rows.
// - Channel members, when known: kv key `channel-members:{channelId}` holding a JSON array of user ids.
//   Nothing writes it yet, so a watcher is mentioned in the thread unless their subscription says DM.
// - The window: `windowFromRows` over the incident's `notify` outbox rows, including rows an earlier
//   event of the same append just enqueued.

import { defaultPlaybook, parseCachedPlaybook, type Playbook } from '../../config/playbook.ts';
import type { IncidentEvent } from '../../contracts/events.ts';
import { StateNotFoundError, type Subscription } from '../../contracts/state.ts';
import { milestoneFor } from '../../notify/milestone.ts';
import type { NotifyContext } from '../../notify/policy.ts';
import { ConfigWorkspaceAmbiguousError, getConfigVersion } from '../config.ts';
import type { StateContext } from '../context.ts';
import { kvGet } from '../kv.ts';
import { outboxRowsOf } from '../outbox.ts';
import type { IncidentChange } from './outbox/index.ts';
import { NOTIFY_OP, windowFromRows } from './outbox/notify.ts';
import { loadStandingSubscriptions } from './subscriptions.ts';

/** kv key of a channel's member list (a JSON array of user ids), when something knows it. */
export function channelMembersKey(channelId: string): string {
  return `channel-members:${channelId}`;
}

async function cachedPlaybook(tx: StateContext): Promise<Playbook> {
  try {
    const cached = await getConfigVersion(tx, 'playbook');
    return parseCachedPlaybook(cached.body) ?? defaultPlaybook();
  } catch (err) {
    if (err instanceof StateNotFoundError || err instanceof ConfigWorkspaceAmbiguousError) return defaultPlaybook();
    throw err;
  }
}

async function channelMembers(tx: StateContext, channelId: string | undefined): Promise<ReadonlySet<string> | undefined> {
  if (channelId === undefined) return undefined;
  const raw = await kvGet(tx, channelMembersKey(channelId));
  if (raw === undefined) return undefined;
  try {
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list) ? new Set(list.filter((u): u is string => typeof u === 'string')) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The notify context for `event`, or undefined when the event is not a milestone. `incidentSubs` are
 * the incident-scoped subscriptions after the event.
 */
export async function loadNotifyContext(
  tx: StateContext,
  event: IncidentEvent,
  change: Pick<IncidentChange, 'before' | 'after' | 'valid'>,
  incidentSubs: readonly Subscription[],
): Promise<NotifyContext | undefined> {
  if (!change.valid || milestoneFor(event, change.after, change.before) === undefined) return undefined;
  const incident = change.after;
  const playbook = await cachedPlaybook(tx);
  const standing = await loadStandingSubscriptions(tx, incident.workspaceId, incident.surfaceId);
  const members = await channelMembers(tx, incident.channelId);
  const window = windowFromRows(await outboxRowsOf(tx, incident.id, NOTIFY_OP));
  return {
    playbook: playbook.notifications,
    subscriptions: [...incidentSubs, ...standing],
    ...(members === undefined ? {} : { channelMembers: members }),
    ...(window === undefined ? {} : { window }),
  };
}
