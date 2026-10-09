// The notification policy (A 4.4), pure: who hears about a milestone, in the thread or by DM, and
// when the message may go out. Off by default beyond the silent pinned edit; three things turn it on.
//
// - Watchers. A `watch` on the incident (an incident-scoped subscription), a standing subscription to
//   the incident's surface ("keep me posted on the website", `<cli> watch web`), or one to everything
//   (scope `all`) are mentioned on every milestone. They are mentioned in the incident's thread, or
//   sent a DM when their subscription is a DM one or they are not in the channel (`channelMembers`,
//   when the caller knows it). A watcher who subscribed from the other chat platform cannot read the
//   thread, so they get a DM too. A DM goes to the platform the watcher subscribed from.
//   A standing watcher (surface or `all`) hears only about what a status answer would show them
//   (`status/ask.ts`, #272): an incident with no chat thread, one they reported, or one in a channel
//   they are known to be in (`channelMembers`). The member list carries, for a person the map lists on
//   both platforms, their id on the other one too (#301), so such a person is in a Teams channel by their
//   Slack id and the reverse; anyone else only by the id they subscribed with. An unknown member list
//   shows them nothing. A watch on the incident itself was asked for in its thread and always applies.
// - The playbook's `forcePush` (6.2): an incident whose priority is at least a forced priority, or on
//   a forced surface, is pushed even with no watchers; the reporter is mentioned with the watchers.
// - The reporter, on the staging check, always. That is a request, not a notification, so it skips
//   quiet hours, the rate limit, and the burst merge, and does not depend on the playbook.
//
// Timing, for everything but that request. Notifications of one incident share a window of
// `rateLimit.perIncident` (PT5M by default): the first milestone opens it, every milestone before it
// closes joins the same batch key, and the batch goes out once, when it closes, so a burst becomes
// one message and an incident never sends more than one per interval. A window that closes inside
// quiet hours is held to the end of them, unless the incident's priority is at least
// `exceptPriority`. Everything held joins the same batch, so a night of milestones is one message in
// the morning. The outbox projector merges rows with one `batch_key` (B 7.1); each row here carries
// its own text, and the merged message lists them in order.
//
// "At least" reads in Jira order: Highest, High, Medium, Low, Lowest. `forcePush priority="High"`
// forces High and Highest. An unknown priority matches nothing.

import type { PlaybookNotifications, QuietHours } from '../config/playbook.ts';
import type { Subscription } from '../contracts/state.ts';
import { parseDuration } from '../util/duration.ts';
import type { Milestone } from './milestone.ts';

/** The burst window when the playbook gives no usable rate limit (A 4.4: five minutes). */
export const DEFAULT_WINDOW_MS = 5 * 60_000;

const PRIORITIES: readonly string[] = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];

/** The open batch of an incident: the window key and when the batch goes out. */
export interface NotifyWindow {
  key: string;
  sendAt: string;
}

/** What the policy needs besides the event; the caller loads it (see `windowFromRows`). */
export interface NotifyContext {
  /** The playbook's `<notifications>`. */
  playbook: PlaybookNotifications;
  /**
   * The workspace's subscriptions that can apply: the incident's, its surface's, and `all`. Rows for
   * other incidents or surfaces are ignored, so passing every row is safe.
   */
  subscriptions: readonly Subscription[];
  /** Users in the incident's channel, when known; a watcher outside it gets a DM. */
  channelMembers?: ReadonlySet<string>;
  /** The incident's newest notification batch, when there is one. */
  window?: NotifyWindow;
}

export interface NotifyIncident {
  id: string;
  surfaceId?: string;
  priority?: string;
  reporterId?: string;
  jiraKey?: string;
  /** The chat platform of the incident's thread; absent for an incident with no thread. */
  platform?: 'slack' | 'teams';
}

export type NoticeReason = 'watch' | 'policy' | 'request';

/** One message to send; `mentions` are users to mention in the thread, or the one user to DM. */
export interface Notice {
  delivery: 'thread' | 'dm';
  mentions: string[];
  milestone: Milestone;
  text: string;
  reason: NoticeReason;
  /** Batch key parts: `notify:{windowKey}:{deliveryKey}`. */
  windowKey: string;
  deliveryKey: string;
  /** ISO time the row may be sent. */
  sendAt: string;
  /**
   * A DM's platform: the one the watcher subscribed from. Absent for a thread message, and for a
   * subscription with no platform recorded; such a DM goes to the incident's platform.
   */
  platform?: 'slack' | 'teams';
}

const MILESTONE_TEXT: Readonly<Record<Milestone, (key: string) => string>> = {
  filed: (k) => `${k} is filed.`,
  'pr-open': (k) => `A fix is up for ${k}.`,
  merged: (k) => `The fix for ${k} is merged.`,
  staging: (k) => `The fix for ${k} is on staging.`,
  live: (k) => `${k} is live.`,
  stopped: (k) => `${k} was stopped.`,
  failed: (k) => `Couldn't produce a passing fix for ${k}.`,
};

const mention = (ref: string): string => `<@${ref.replace(/[<>\s]/g, '')}>`;

/** True when `priority` is the same as or more urgent than `threshold`. */
export function priorityAtLeast(priority: string | undefined, threshold: string): boolean {
  if (priority === undefined) return false;
  const have = PRIORITIES.indexOf(priority);
  const want = PRIORITIES.indexOf(threshold);
  return have >= 0 && want >= 0 && have <= want;
}

/** True when the playbook forces push updates for this incident. */
export function isForcePush(playbook: PlaybookNotifications, incident: NotifyIncident): boolean {
  return playbook.forcePush.some((f) =>
    'priority' in f ? priorityAtLeast(incident.priority, f.priority) : incident.surfaceId !== undefined && f.surface === incident.surfaceId,
  );
}

/** Whether a standing watcher may hear about `incident` (see the file header); an incident watch always may. */
export function watcherMayHear(incident: NotifyIncident, s: Subscription, members: ReadonlySet<string> | undefined): boolean {
  if (s.scopeKind === 'incident' || incident.platform === undefined || s.userId === incident.reporterId) return true;
  return members?.has(s.userId) === true;
}

/**
 * The subscriptions that apply to `incident` (incident, surface, and `all`) and that it may reach
 * (`watcherMayHear` over `members`), one per user, ordered by user.
 */
export function watchersOf(incident: NotifyIncident, subscriptions: readonly Subscription[], members?: ReadonlySet<string>): Subscription[] {
  const seen = new Map<string, Subscription>();
  for (const s of subscriptions) {
    const applies =
      s.scopeKind === 'all' ||
      (s.scopeKind === 'incident' && s.scopeId === incident.id) ||
      (s.scopeKind === 'surface' && incident.surfaceId !== undefined && s.scopeId === incident.surfaceId);
    if (!applies || !watcherMayHear(incident, s, members)) continue;
    const prior = seen.get(s.userId);
    // A thread subscription outranks a DM one for the same person: they chose to hear it in the thread.
    if (prior === undefined || (prior.channel === 'dm' && s.channel === 'thread')) seen.set(s.userId, s);
  }
  return [...seen.values()].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}

function windowMs(playbook: PlaybookNotifications): number {
  try {
    const ms = parseDuration(playbook.rateLimit.perIncident);
    return ms > 0 ? ms : DEFAULT_WINDOW_MS;
  } catch {
    return DEFAULT_WINDOW_MS;
  }
}

function localMinutes(ms: number, tz: string): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value);
    return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : undefined;
  } catch {
    return undefined;
  }
}

function clockMinutes(hhmm: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (m === null) return undefined;
  const total = Number(m[1]) * 60 + Number(m[2]);
  return total < 24 * 60 ? total : undefined;
}

/**
 * When quiet hours end if `ms` falls inside them, else undefined. `from` to `to` may wrap midnight
 * (20:00 to 08:00); equal bounds mean no quiet hours. A bad time zone or clock value means none too:
 * the policy runs inside an append, so it must not throw on configuration.
 */
export function quietEnd(ms: number, quiet: QuietHours): number | undefined {
  const from = clockMinutes(quiet.from);
  const to = clockMinutes(quiet.to);
  const now = localMinutes(ms, quiet.tz);
  if (from === undefined || to === undefined || now === undefined || from === to) return undefined;
  const inside = from < to ? now >= from && now < to : now >= from || now < to;
  if (!inside) return undefined;
  const minuteStart = ms - (ms % 60_000);
  return minuteStart + ((to - now + 24 * 60) % (24 * 60)) * 60_000;
}

export interface PlanInput {
  milestone: Milestone;
  incident: NotifyIncident;
  /** The event's `recordedAt`, and its seq (names a new window). */
  at: string;
  seq: number;
  context: NotifyContext;
}

/**
 * The messages `milestone` calls for, in the order they are enqueued: the reporter's request on the
 * staging check first, then the thread message, then one DM per watcher who is not in the thread.
 * Empty when nobody is to hear about it.
 */
export function planNotices(input: PlanInput): Notice[] {
  const { milestone, incident, context } = input;
  const at = Date.parse(input.at);
  const text = MILESTONE_TEXT[milestone](incident.jiraKey ?? 'the ticket');
  const notices: Notice[] = [];

  const reporter = incident.reporterId;
  const request = milestone === 'staging' && reporter !== undefined;
  if (request) {
    notices.push({
      delivery: 'thread',
      mentions: [reporter],
      milestone,
      text: `${mention(reporter)} ${text} Can you check?`,
      reason: 'request',
      windowKey: `${incident.id}:${String(input.seq)}`,
      deliveryKey: 'request',
      sendAt: input.at,
    });
  }

  const forced = isForcePush(context.playbook, incident);
  const watchers = watchersOf(incident, context.subscriptions, context.channelMembers).filter((s) => !(request && s.userId === reporter));
  const threadUsers: string[] = [];
  const dms: Subscription[] = [];
  for (const s of watchers) {
    const elsewhere = s.platform !== undefined && incident.platform !== undefined && s.platform !== incident.platform;
    const inChannel = !elsewhere && (context.channelMembers === undefined || context.channelMembers.has(s.userId));
    if (s.channel === 'dm' || !inChannel) dms.push(s);
    else threadUsers.push(s.userId);
  }
  if (forced && reporter !== undefined && !request && !threadUsers.includes(reporter) && !dms.some((s) => s.userId === reporter)) {
    threadUsers.push(reporter);
  }
  if (threadUsers.length === 0 && dms.length === 0 && !forced) return notices;

  // The burst window, and the time its batch goes out.
  const open = context.window !== undefined && at < Date.parse(context.window.sendAt) ? context.window : undefined;
  let windowKey = `${incident.id}:${String(input.seq)}`;
  let sendMs: number;
  if (open !== undefined) {
    windowKey = open.key;
    sendMs = Date.parse(open.sendAt);
  } else {
    sendMs = at + windowMs(context.playbook);
    const quiet = context.playbook.quietHours;
    if (quiet !== undefined && !(quiet.exceptPriority !== undefined && priorityAtLeast(incident.priority, quiet.exceptPriority))) {
      sendMs = quietEnd(sendMs, quiet) ?? sendMs;
    }
  }
  const sendAt = new Date(sendMs).toISOString();

  const prefix = threadUsers.map(mention).join(' ');
  if (threadUsers.length > 0 || forced) {
    notices.push({
      delivery: 'thread',
      mentions: threadUsers,
      milestone,
      text: prefix === '' ? text : `${prefix} ${text}`,
      reason: forced ? 'policy' : 'watch',
      windowKey,
      deliveryKey: 'thread',
      sendAt,
    });
  }
  for (const { userId, platform } of dms) {
    notices.push({
      delivery: 'dm',
      mentions: [userId],
      milestone,
      text,
      reason: forced ? 'policy' : 'watch',
      windowKey,
      deliveryKey: `dm:${userId}`,
      sendAt,
      ...(platform === undefined ? {} : { platform }),
    });
  }
  return notices;
}
