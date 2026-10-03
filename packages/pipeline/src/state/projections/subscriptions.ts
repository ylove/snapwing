// The `subscriptions` projection (B 3, A 4.4), for the rows an incident's log implies: a `watch`
// signal (a `comment` event with intent `watch`) subscribes its actor to the incident in the thread;
// removing the reaction unsubscribes (A 1.6). Standing surface and workspace subscriptions ("keep
// me posted on the website", `<cli> watch web`) are not incident events and are written elsewhere.
// `created_at` is the watch event's `occurredAt`; watching again keeps the first one.

import type { Selectable } from 'kysely';
import type { IncidentEvent } from '../../contracts/events.ts';
import type { Subscription } from '../../contracts/state.ts';
import type { StateContext } from '../context.ts';
import type { SubscriptionsTable } from '../db.ts';

/** `scope_id` for scope `all` (ADR 0011). */
export const ALL_SCOPE_ID = '';

const codeOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Order for subscription lists: user, then scope kind, then scope id. */
export const bySubscription = (a: Subscription, b: Subscription): number =>
  codeOrder(a.userId, b.userId) || codeOrder(a.scopeKind, b.scopeKind) || codeOrder(a.scopeId ?? ALL_SCOPE_ID, b.scopeId ?? ALL_SCOPE_ID);

/**
 * The incident-scoped subscriptions (`scope_kind` `incident` on this incident) after `e`. Pure;
 * sorted by user; the input array when nothing changed.
 */
export function foldIncidentSubscriptions(subs: readonly Subscription[], e: IncidentEvent): readonly Subscription[] {
  if (e.type !== 'comment' || e.payload.intent !== 'watch' || e.actor === undefined) {
    return subs;
  }
  const userId = e.actor.id;
  const has = subs.some((s) => s.userId === userId);
  if (e.payload.signalSource === 'reaction-removed') {
    return has ? subs.filter((s) => s.userId !== userId) : subs;
  }
  if (has) {
    return subs;
  }
  const added: Subscription = {
    workspaceId: e.workspaceId,
    userId,
    scopeKind: 'incident',
    scopeId: e.incidentId,
    channel: 'thread',
    createdAt: e.occurredAt,
  };
  return [...subs, added].sort(bySubscription);
}

// Table mapping -----------------------------------------------------------------------------------

export function rowToSubscription(ctx: StateContext, r: Selectable<SubscriptionsTable>): Subscription {
  return {
    workspaceId: r.workspace_id,
    userId: r.user_id,
    scopeKind: r.scope_kind,
    ...(r.scope_kind !== 'all' ? { scopeId: r.scope_id } : {}),
    channel: r.channel,
    createdAt: ctx.codec.fromTimestamp(r.created_at),
  };
}

export async function loadIncidentSubscriptions(ctx: StateContext, workspaceId: string, incidentId: string): Promise<Subscription[]> {
  const rows = await ctx.db
    .selectFrom('subscriptions')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('scope_kind', '=', 'incident')
    .where('scope_id', '=', incidentId)
    .execute();
  return rows.map((r) => rowToSubscription(ctx, r)).sort(bySubscription);
}

/** Replaces the incident-scoped subscriptions with `subs`. */
export async function writeIncidentSubscriptions(ctx: StateContext, workspaceId: string, incidentId: string, subs: readonly Subscription[]): Promise<void> {
  await ctx.db
    .deleteFrom('subscriptions')
    .where('workspace_id', '=', workspaceId)
    .where('scope_kind', '=', 'incident')
    .where('scope_id', '=', incidentId)
    .execute();
  if (subs.length === 0) {
    return;
  }
  await ctx.db
    .insertInto('subscriptions')
    .values(
      subs.map((s) => ({
        workspace_id: s.workspaceId,
        user_id: s.userId,
        scope_kind: s.scopeKind,
        scope_id: s.scopeId ?? ALL_SCOPE_ID,
        channel: s.channel,
        created_at: ctx.codec.timestamp(s.createdAt),
      })),
    )
    .execute();
}

// Standing subscriptions ----------------------------------------------------------------------------
// Scope `surface` ("keep me posted on the website") and scope `all`: not derived from events, so
// rebuild leaves them alone and these writers are their only source.

/**
 * Writes a standing subscription (scope `surface` or `all`). The person's earlier row for the same scope
 * is replaced, so changing `thread` to `dm` keeps one row; `createdAt` stays the first one's.
 */
export async function putStandingSubscription(ctx: StateContext, sub: Subscription): Promise<void> {
  if (sub.scopeKind === 'incident') {
    throw new TypeError('putStandingSubscription: scope incident is written by the watch signal, not here');
  }
  const scopeId = sub.scopeKind === 'all' ? ALL_SCOPE_ID : sub.scopeId;
  if (scopeId === undefined || (sub.scopeKind === 'surface' && scopeId === '')) {
    throw new TypeError('putStandingSubscription: scope surface needs a scopeId');
  }
  await ctx.db
    .insertInto('subscriptions')
    .values({
      workspace_id: sub.workspaceId,
      user_id: sub.userId,
      scope_kind: sub.scopeKind,
      scope_id: scopeId,
      channel: sub.channel,
      created_at: ctx.codec.timestamp(sub.createdAt),
    })
    .onConflict((oc) => oc.columns(['workspace_id', 'user_id', 'scope_kind', 'scope_id']).doUpdateSet({ channel: sub.channel }))
    .execute();
}

/** Removes a standing subscription; true when there was one. */
export async function removeStandingSubscription(
  ctx: StateContext,
  key: { workspaceId: string; userId: string; scopeKind: 'surface' | 'all'; scopeId?: string },
): Promise<boolean> {
  const scopeId = key.scopeKind === 'all' ? ALL_SCOPE_ID : (key.scopeId ?? '');
  const res = await ctx.db
    .deleteFrom('subscriptions')
    .where('workspace_id', '=', key.workspaceId)
    .where('user_id', '=', key.userId)
    .where('scope_kind', '=', key.scopeKind)
    .where('scope_id', '=', scopeId)
    .executeTakeFirst();
  return Number(res.numDeletedRows) > 0;
}

/** The workspace's surface and `all` subscriptions that can apply to an incident on `surfaceId`. */
export async function loadStandingSubscriptions(ctx: StateContext, workspaceId: string, surfaceId: string | undefined): Promise<Subscription[]> {
  const rows = await ctx.db
    .selectFrom('subscriptions')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where((eb) =>
      eb.or([
        eb('scope_kind', '=', 'all'),
        ...(surfaceId === undefined ? [] : [eb.and([eb('scope_kind', '=', 'surface'), eb('scope_id', '=', surfaceId)])]),
      ]),
    )
    .execute();
  return rows.map((r) => rowToSubscription(ctx, r)).sort(bySubscription);
}
