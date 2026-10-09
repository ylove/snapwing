// Graph change-notification subscriptions for Teams channel messages (main 15.2 emoji trigger row,
// ADR 0005). Bot Framework `messageReaction` fires only for messages the bot sent, so reactions on
// human messages arrive as `chatMessage` change notifications and the emoji trigger diffs `reactions`.
//
// - One subscription per team in the map: `/teams/{id}/channels/getAllMessages`, change types `created`
//   and `updated`. Channel-message subscriptions last at most 60 minutes, so `ensure` renews at 45 and the
//   worker calls `ensureAll` every `SUBSCRIPTION_TICK_MS`. State is kv `teams-subscription:{teamId}`
//   (JSON `{ id, expiresAt, since }`), plus `teams-subscription-id:{id}` so a lifecycle notification, which
//   does not name a team, finds its team. `since` is when the team's notifications started: when a
//   subscription was asked for with no state kept, carried across renewals and recreations, so the signals
//   never count a reaction older than it on a message they first see (`subscriptionSince`).
// - `handleValidation(req)` answers Graph's `validationToken` handshake: the token echoed as `text/plain`
//   with `nosniff`, and only when it is at most `MAX_VALIDATION_TOKEN` characters of printable ASCII (a 400
//   otherwise), so the route never reflects markup or a large body (#269). `verifyNotification(body)` keeps
//   only notifications whose `clientState` matches (constant time) and drops the rest, forged or not.
//   `handleLifecycle(body)` runs the verified lifecycle events: `reauthorizationRequired` renews,
//   `subscriptionRemoved` recreates, `missed` is reported so the caller can resync.
// - Degraded mode. Whether channel-message notifications also need Microsoft's protected-API approval or
//   metered billing is unverified (an open question). Graph answers such a gap with 403 (no RSC grant,
//   no approval) or 402 (metered API not enabled); both mark the team reduced in kv `teams-mode:{teamId}`
//   (JSON `{ mode: 'reduced', since, retryAt, reason }`) and the team is retried hourly, so a grant that
//   appears later lifts the mode on the next retry (`{ mode: 'full', since }`). In reduced mode the
//   action command and personal chat keep working; only the emoji trigger is off. Nothing throws for it.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { CachePort } from '@snapwing/pipeline/ports/cache.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { readTeamsModeMark, writeTeamsMode } from './conversations.ts';
import { GraphApiError, GraphPermissionError, GraphRateLimitError, type GraphSubscription, type TeamsGraph } from './graph.ts';

/** The longest `validationToken` echoed back; Graph's are far shorter. */
export const MAX_VALIDATION_TOKEN = 1024;
const PRINTABLE = /^[\x20-\x7e]+$/;
const TEXT_HEADERS = { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' } as const;

/** Graph caps a channel-message subscription at 60 minutes. */
export const SUBSCRIPTION_MAX_MS = 60 * 60 * 1000;
/** Renew when 45 minutes of the 60 are used. */
export const SUBSCRIPTION_RENEW_AFTER_MS = 45 * 60 * 1000;
/** Expiry asked for: a minute under the cap so clock skew never trips Graph's limit. */
export const SUBSCRIPTION_LIFETIME_MS = SUBSCRIPTION_MAX_MS - 60 * 1000;
/** How often the worker should call `ensureAll`. */
export const SUBSCRIPTION_TICK_MS = 5 * 60 * 1000;
/** A reduced team is retried this often. */
export const REDUCED_RETRY_MS = 60 * 60 * 1000;
export const SUBSCRIPTION_CHANGE_TYPES = 'created,updated';

export const subscriptionKey = (teamId: string): string => `teams-subscription:${teamId}`;
export const subscriptionIdKey = (subscriptionId: string): string => `teams-subscription-id:${subscriptionId}`;
export const subscriptionResource = (teamId: string): string => `/teams/${teamId}/channels/getAllMessages`;

export type TeamsMode = { mode: 'full'; since: string } | { mode: 'reduced'; since: string; retryAt: string; reason: string };

export interface SubscriptionState {
  id: string;
  expiresAt: string;
  /** ISO 8601: when the team's notifications started (absent in state written before it was kept). */
  since?: string;
}

export type EnsureOutcome =
  | { kind: 'created'; teamId: string; id: string; expiresAt: string }
  | { kind: 'renewed'; teamId: string; id: string; expiresAt: string }
  | { kind: 'active'; teamId: string; id: string; expiresAt: string }
  | { kind: 'reduced'; teamId: string; reason: string; retryAt: string }
  | { kind: 'retry'; teamId: string; afterMs: number }
  | { kind: 'error'; teamId: string; error: unknown };

/** A change notification whose `clientState` matched. */
export interface VerifiedNotification {
  subscriptionId: string;
  changeType?: string;
  /** Present on lifecycle notifications. */
  lifecycleEvent?: string;
  resource?: string;
  /** Parsed from `teams('T')/channels('C')/messages('M')/replies('R')` when the resource has that shape. */
  teamId?: string;
  channelId?: string;
  messageId?: string;
  replyId?: string;
}

export type LifecycleOutcome =
  | { kind: 'reauthorized'; subscriptionId: string; outcome: EnsureOutcome }
  | { kind: 'recreated'; subscriptionId: string; outcome: EnsureOutcome }
  | { kind: 'missed'; subscriptionId: string }
  | { kind: 'unknown-subscription'; subscriptionId: string }
  | { kind: 'ignored'; subscriptionId: string };

export interface TeamsSubscriptionsOptions {
  graph: Pick<TeamsGraph, 'createSubscription' | 'renewSubscription'>;
  cache: CachePort;
  /** Where Graph posts change notifications (HTTPS, reachable from Graph). */
  notificationUrl: string;
  /** Where Graph posts lifecycle notifications. */
  lifecycleUrl: string;
  /** Shared secret Graph echoes on every notification (max 128 characters). */
  clientState: string;
  now?: () => Date;
  onError?: (teamId: string, error: unknown) => void;
}

export interface TeamsSubscriptions {
  /** Creates, renews, or leaves alone the one subscription of `teamId`; never throws. */
  ensure(teamId: string): Promise<EnsureOutcome>;
  /** `ensure` for every team; one failing team does not stop the rest. */
  ensureAll(teamIds: readonly string[]): Promise<EnsureOutcome[]>;
  /** The team's mode: full unless a 403 or 402 marked it reduced. */
  mode(teamId: string): Promise<TeamsMode>;
  /** The handshake response for `?validationToken=...`, or undefined when `req` is not a handshake. */
  handleValidation(req: Request): Response | undefined;
  /** Notifications of `body` that carry our `clientState`; everything else is dropped. */
  verifyNotification(body: unknown): VerifiedNotification[];
  /** Acts on the verified lifecycle events of `body`. */
  handleLifecycle(body: unknown): Promise<LifecycleOutcome[]>;
}

/** The Teams team ids the map names, once each. */
export function teamIdsInMap(map: WorkspaceMap): string[] {
  const ids = new Set<string>();
  for (const channel of map.channels) if (channel.platform === 'teams' && channel.teamId) ids.add(channel.teamId);
  return [...ids];
}

function digest(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

/** Constant-time string equality: both sides are hashed so length never leaks. */
function sameSecret(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string') return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function readState(raw: string | null): SubscriptionState | undefined {
  const v = parseJson(raw);
  if (typeof v !== 'object' || v === null) return undefined;
  const rec = v as Record<string, unknown>;
  const expires = typeof rec['expiresAt'] === 'string' ? Date.parse(rec['expiresAt']) : Number.NaN;
  if (typeof rec['id'] !== 'string' || !Number.isFinite(expires)) return undefined;
  const since = typeof rec['since'] === 'string' && Number.isFinite(Date.parse(rec['since'])) ? rec['since'] : undefined;
  return { id: rec['id'], expiresAt: rec['expiresAt'] as string, ...(since === undefined ? {} : { since }) };
}

/** When the team's notifications started, or undefined when no subscription state keeps it. */
export async function subscriptionSince(cache: Pick<CachePort, 'get'>, teamId: string): Promise<string | undefined> {
  return readState(await cache.get(subscriptionKey(teamId)))?.since;
}

const RESOURCE_RE = /teams\('([^']+)'\)\/channels\('([^']+)'\)\/messages\('([^']+)'\)(?:\/replies\('([^']+)'\))?/;

function parseNotification(raw: unknown, clientState: string): VerifiedNotification | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;
  if (!sameSecret(rec['clientState'], clientState)) return undefined;
  if (typeof rec['subscriptionId'] !== 'string') return undefined;
  const out: VerifiedNotification = { subscriptionId: rec['subscriptionId'] };
  if (typeof rec['changeType'] === 'string') out.changeType = rec['changeType'];
  if (typeof rec['lifecycleEvent'] === 'string') out.lifecycleEvent = rec['lifecycleEvent'];
  if (typeof rec['resource'] === 'string') {
    out.resource = rec['resource'];
    const m = RESOURCE_RE.exec(rec['resource']);
    if (m) {
      out.teamId = m[1] as string;
      out.channelId = m[2] as string;
      out.messageId = m[3] as string;
      if (m[4] !== undefined) out.replyId = m[4];
    }
  }
  return out;
}

export function createTeamsSubscriptions(options: TeamsSubscriptionsOptions): TeamsSubscriptions {
  const { graph, cache, notificationUrl, lifecycleUrl, clientState } = options;
  const now = options.now ?? ((): Date => new Date());
  const inflight = new Map<string, Promise<EnsureOutcome>>();

  async function load(teamId: string): Promise<SubscriptionState | undefined> {
    return readState(await cache.get(subscriptionKey(teamId)));
  }

  /** Keeps `sub`; `askedAt` is when it was asked for (a new subscription notifies from then on). */
  async function save(teamId: string, sub: GraphSubscription, askedAt: Date = now()): Promise<SubscriptionState> {
    // The start survives a renewal and a recreation; a reduced team's cleared state starts again.
    const since = (await load(teamId))?.since ?? askedAt.toISOString();
    const state: SubscriptionState = { id: sub.id, expiresAt: sub.expirationDateTime, since };
    await cache.set(subscriptionKey(teamId), JSON.stringify(state));
    await cache.set(subscriptionIdKey(sub.id), teamId);
    return state;
  }

  async function mode(teamId: string): Promise<TeamsMode> {
    const mark = await readTeamsModeMark(cache, teamId);
    if (mark?.mode === 'reduced') {
      // A mark without a retry time (the RSC mode check writes none) is retried on the next tick.
      return { mode: 'reduced', since: mark.since, retryAt: mark.retryAt ?? '', reason: mark.reason ?? 'RSC permissions not granted' };
    }
    return { mode: 'full', since: mark?.since ?? '' };
  }

  async function markFull(teamId: string): Promise<void> {
    if ((await readTeamsModeMark(cache, teamId))?.mode === 'full') return;
    await writeTeamsMode(cache, teamId, 'full', { since: now().toISOString() });
  }

  async function markReduced(teamId: string, reason: string): Promise<EnsureOutcome> {
    const at = now();
    const retryAt = new Date(at.getTime() + REDUCED_RETRY_MS).toISOString();
    const prior = await mode(teamId);
    const since = prior.mode === 'reduced' && prior.since !== '' ? prior.since : at.toISOString();
    await writeTeamsMode(cache, teamId, 'reduced', { since, retryAt, reason });
    await cache.set(subscriptionKey(teamId), '');
    return { kind: 'reduced', teamId, reason, retryAt };
  }

  function expiry(): string {
    return new Date(now().getTime() + SUBSCRIPTION_LIFETIME_MS).toISOString();
  }

  async function create(teamId: string): Promise<EnsureOutcome> {
    const askedAt = now();
    const sub = await graph.createSubscription({
      resource: subscriptionResource(teamId),
      changeType: SUBSCRIPTION_CHANGE_TYPES,
      notificationUrl,
      lifecycleNotificationUrl: lifecycleUrl,
      expirationDateTime: expiry(),
      clientState,
    });
    const state = await save(teamId, sub, askedAt);
    await markFull(teamId);
    return { kind: 'created', teamId, id: state.id, expiresAt: state.expiresAt };
  }

  async function run(teamId: string, forceRenew: boolean, recreate: boolean): Promise<EnsureOutcome> {
    try {
      const current = await mode(teamId);
      if (current.mode === 'reduced' && now().getTime() < Date.parse(current.retryAt)) {
        return { kind: 'reduced', teamId, reason: current.reason, retryAt: current.retryAt };
      }
      const state = recreate ? undefined : await load(teamId);
      if (!state) return await create(teamId);
      const due = forceRenew || Date.parse(state.expiresAt) - now().getTime() <= SUBSCRIPTION_LIFETIME_MS - SUBSCRIPTION_RENEW_AFTER_MS;
      if (!due) return { kind: 'active', teamId, id: state.id, expiresAt: state.expiresAt };
      try {
        const sub = await graph.renewSubscription(state.id, expiry());
        const renewed = await save(teamId, sub);
        await markFull(teamId);
        return { kind: 'renewed', teamId, id: renewed.id, expiresAt: renewed.expiresAt };
      } catch (error) {
        // Graph forgot it (expired or removed): start over. Anything else is handled below.
        if (error instanceof GraphApiError && error.status === 404) return await create(teamId);
        throw error;
      }
    } catch (error) {
      if (error instanceof GraphPermissionError) return markReduced(teamId, `missing ${error.permission}`);
      if (error instanceof GraphApiError && error.status === 402) return markReduced(teamId, 'metered API not enabled');
      if (error instanceof GraphRateLimitError) return { kind: 'retry', teamId, afterMs: error.retryAfterMs };
      options.onError?.(teamId, error);
      return { kind: 'error', teamId, error };
    }
  }

  /** One run per team at a time: a lifecycle event and the tick never race on the same state. */
  function serial(teamId: string, forceRenew: boolean, recreate: boolean): Promise<EnsureOutcome> {
    const prior = inflight.get(teamId) ?? Promise.resolve();
    const next = prior.then(() => run(teamId, forceRenew, recreate));
    inflight.set(teamId, next);
    void next.then(() => {
      if (inflight.get(teamId) === next) inflight.delete(teamId);
    });
    return next;
  }

  const subscriptions: TeamsSubscriptions = {
    ensure: (teamId) => serial(teamId, false, false),
    ensureAll: (teamIds) => Promise.all(teamIds.map((id) => subscriptions.ensure(id))),
    mode,
    handleValidation(req) {
      const token = new URL(req.url).searchParams.get('validationToken');
      if (token === null) return undefined;
      if (token.length > MAX_VALIDATION_TOKEN || !PRINTABLE.test(token)) return new Response('', { status: 400, headers: TEXT_HEADERS });
      return new Response(token, { status: 200, headers: TEXT_HEADERS });
    },
    verifyNotification(body) {
      if (typeof body !== 'object' || body === null) return [];
      const value = (body as Record<string, unknown>)['value'];
      if (!Array.isArray(value)) return [];
      const out: VerifiedNotification[] = [];
      for (const raw of value) {
        const n = parseNotification(raw, clientState);
        if (n) out.push(n);
      }
      return out;
    },
    async handleLifecycle(body) {
      const out: LifecycleOutcome[] = [];
      for (const n of subscriptions.verifyNotification(body)) {
        const { subscriptionId, lifecycleEvent } = n;
        if (lifecycleEvent === 'missed') {
          out.push({ kind: 'missed', subscriptionId });
          continue;
        }
        if (lifecycleEvent !== 'reauthorizationRequired' && lifecycleEvent !== 'subscriptionRemoved') {
          out.push({ kind: 'ignored', subscriptionId });
          continue;
        }
        const teamId = await cache.get(subscriptionIdKey(subscriptionId));
        if (!teamId) {
          out.push({ kind: 'unknown-subscription', subscriptionId });
          continue;
        }
        if (lifecycleEvent === 'reauthorizationRequired') {
          out.push({ kind: 'reauthorized', subscriptionId, outcome: await serial(teamId, true, false) });
        } else {
          out.push({ kind: 'recreated', subscriptionId, outcome: await serial(teamId, false, true) });
        }
      }
      return out;
    },
  };
  return subscriptions;
}
