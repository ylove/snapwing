// Projections (B 3, B 4, B 5, A 1.3): incidents, claims, subscriptions, escalation scores, bot messages, folded from the
// event log inside the append transaction, and the store's reads over them.
//
// Each table has a pure reducer next to its mapping: `foldIncident` (incidents.ts), `foldClaims`
// (claims.ts), `foldIncidentSubscriptions` (subscriptions.ts), `foldScores` (escalation.ts); `bot_messages`
// is written per event by `writeBotMessage` (bot-messages.ts). None
// reads the clock: every timestamp comes from an event, and JSON arrays are kept sorted, so
// replaying a log writes the same rows on both dialects. `applyProjections` loads an incident's
// rows once, folds the events in seq order, and writes back only the tables that changed. Events
// for an incident with no `captured` event yet fold to nothing. An event that does not fit the
// incident's status (`isValidTransition`, #11) keeps the status and is logged as a warning, as is
// a `corrected` event the incidents fold ignores (ADR 0014). Corrections refold the incidents row
// only; claims, subscriptions, and escalation scores keep what the events as recorded gave them.

import { sql } from 'kysely';
import type { IncidentEvent } from '../../contracts/events.ts';
import type { EscalationScore } from '../../contracts/signals.ts';
import type { Claim, IncidentQuery, IncidentStatus, IncidentView, Subscription } from '../../contracts/state.ts';
import { inTransaction, type StateContext } from '../context.ts';
import { read } from '../events.ts';
import { enqueueOutbox } from '../outbox.ts';
import { upcast } from '../upcast.ts';
import { writeBotMessage } from './bot-messages.ts';
import { foldClaims, loadClaims, writeClaims } from './claims.ts';
import { foldScores, loadScores, writeScores, type ScoreRow } from './escalation.ts';
import { foldIncident, loadIncident, rowToIncident, writeIncident } from './incidents.ts';
import { loadNotifyContext } from './notify-context.ts';
import { outboxFor, type IncidentChange } from './outbox.ts';
import { ALL_SCOPE_ID, bySubscription, foldIncidentSubscriptions, loadIncidentSubscriptions, rowToSubscription, writeIncidentSubscriptions } from './subscriptions.ts';

export { getMessageTarget, type MessageRef, type MessageTarget } from './bot-messages.ts';
export { foldClaims } from './claims.ts';
export { foldScores, type ScoreRow } from './escalation.ts';
export { foldIncident, type IncidentFold } from './incidents.ts';
export { outboxFor, type IncidentChange } from './outbox.ts';
export { foldIncidentSubscriptions, putStandingSubscription, removeStandingSubscription } from './subscriptions.ts';

/** `findIncidents` page size when `limit` is absent, and the largest it accepts. */
export const FIND_INCIDENTS_DEFAULT_LIMIT = 100;
export const FIND_INCIDENTS_MAX_LIMIT = 1000;

export interface ApplyProjectionsOptions {
  /**
   * Enqueue the outbox rows `outboxFor` says the events imply; default true. Append leaves it on,
   * so the row exists or the event does not (B 4). Rebuild turns it off: the outbox is a delivery
   * log, not a projection, and replay must not send history again (#89; see rebuild.ts).
   */
  outbox?: boolean;
}

/**
 * Folds `events` into the projection tables inside the append transaction (`tx`), and, unless
 * `options.outbox` is false, enqueues the outbox rows `outboxFor` says they imply. Events are grouped
 * by incident and applied in the order given (seq order, as append and rebuild pass them).
 */
export async function applyProjections(tx: StateContext, events: readonly IncidentEvent[], options: ApplyProjectionsOptions = {}): Promise<void> {
  const outbox = options.outbox ?? true;
  if (events.length === 0) {
    return;
  }
  const byIncident = new Map<string, IncidentEvent[]>();
  for (const e of events) {
    const list = byIncident.get(e.incidentId);
    if (list === undefined) {
      byIncident.set(e.incidentId, [e]);
    } else {
      list.push(e);
    }
  }
  await inTransaction(tx, async (t) => {
    for (const [incidentId, list] of byIncident) {
      await projectIncident(t, incidentId, list, outbox);
    }
  });
}

async function projectIncident(tx: StateContext, incidentId: string, events: readonly IncidentEvent[], outbox: boolean): Promise<void> {
  const before = await loadIncident(tx, incidentId);
  // A correction refolds the log before it (ADR 0014). The batch is already in `incident_events`
  // (append inserts before it projects; rebuild replays stored rows), so the log read here holds
  // it. Upcast as rebuild does, with the default registry.
  const log = events.some((e) => e.type === 'corrected') ? (await read(tx, incidentId)).map((e) => upcast(e)) : [];
  let view = before;
  const steps: { event: IncidentEvent; status: IncidentStatus; change: IncidentChange; subs: readonly Subscription[] }[] = [];
  for (const e of events) {
    const prev = view;
    const from = prev?.status;
    const fold = foldIncident(prev, e, log);
    view = fold.view;
    if (view === undefined) {
      continue;
    }
    if (fold.problem !== undefined) {
      console.warn(`projections: incident ${incidentId} seq ${e.seq}: correction ignored: ${fold.problem}`);
    } else if (!fold.valid && from !== undefined) {
      console.warn(`projections: incident ${incidentId} seq ${e.seq}: event ${e.type} does not fit status ${from}; status kept`);
    }
    steps.push({ event: e, status: view.status, change: { before: prev, after: view, valid: fold.valid }, subs: [] });
  }
  if (view === undefined) {
    return;
  }
  // The incident row first: claims and escalation scores reference it.
  await writeIncident(tx, view, before !== undefined);

  const claimsBefore = before === undefined ? [] : await loadClaims(tx, incidentId);
  const scoresBefore = before === undefined ? [] : await loadScores(tx, incidentId);
  const subsBefore = before === undefined ? [] : await loadIncidentSubscriptions(tx, view.workspaceId, incidentId);
  let claims: readonly Claim[] = claimsBefore;
  let scores: readonly ScoreRow[] = scoresBefore;
  let subs: readonly Subscription[] = subsBefore;
  for (const step of steps) {
    claims = foldClaims(claims, step.event, step.status);
    scores = foldScores(scores, step.event);
    subs = foldIncidentSubscriptions(subs, step.event);
    step.subs = subs;
  }
  if (claims !== claimsBefore) {
    await writeClaims(tx, incidentId, claims);
  }
  if (scores !== scoresBefore) {
    await writeScores(tx, incidentId, scores);
  }
  if (subs !== subsBefore) {
    await writeIncidentSubscriptions(tx, view.workspaceId, incidentId, subs);
  }
  for (const { event } of steps) {
    await writeBotMessage(tx, event);
  }
  if (!outbox) {
    return;
  }
  for (const { event, change, subs: stepSubs } of steps) {
    // The notify context is read per step: a row an earlier event just enqueued opens the burst window.
    const notify = await loadNotifyContext(tx, event, change, stepSubs);
    for (const item of outboxFor(event, notify === undefined ? change : { ...change, notify })) {
      await enqueueOutbox(tx, item);
    }
  }
}

// Reads -------------------------------------------------------------------------------------------

/** See `StatePort.getIncident`. */
export async function getIncident(ctx: StateContext, incidentId: string): Promise<IncidentView | null> {
  return (await loadIncident(ctx, incidentId)) ?? null;
}

/** `%`, `_`, and the escape character itself, escaped for `like ... escape '\'`. */
function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** See `StatePort.findIncidents`. */
export async function findIncidents(ctx: StateContext, q: IncidentQuery): Promise<IncidentView[]> {
  const limit = q.limit ?? FIND_INCIDENTS_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError(`findIncidents: limit must be a positive integer, got ${String(q.limit)}`);
  }
  const statuses: readonly IncidentStatus[] | undefined = q.status === undefined ? undefined : typeof q.status === 'string' ? [q.status] : q.status;
  if (statuses?.length === 0) {
    return [];
  }

  let query = ctx.db.selectFrom('incidents').selectAll();
  if (q.workspaceId !== undefined) {
    query = query.where('workspace_id', '=', q.workspaceId);
  }
  if (q.surfaceId !== undefined) {
    query = query.where('surface_id', '=', q.surfaceId);
  }
  if (statuses !== undefined) {
    query = query.where('status', 'in', [...statuses]);
  }
  if (q.jiraKey !== undefined) {
    query = query.where('jira_key', '=', q.jiraKey);
  }
  if (q.text !== undefined) {
    // lower() on both sides, so the match is case-insensitive the same way the dialect lowercases.
    query = query.where(sql<boolean>`lower(${sql.ref('summary')}) like lower(${likeContains(q.text)}) escape ${'\\'}`);
  }
  if (q.parentId !== undefined) {
    query = query.where('parent_id', '=', q.parentId);
  }
  if (q.kind !== undefined) {
    query = query.where('kind', '=', q.kind);
  }
  const rows = await query
    .orderBy('updated_at', 'desc')
    .orderBy('id')
    .limit(Math.min(limit, FIND_INCIDENTS_MAX_LIMIT))
    .execute();
  return rows.map((r) => rowToIncident(ctx, r));
}

/** See `StatePort.getClaims`. Sorted by claimer. */
export async function getClaims(ctx: StateContext, incidentId: string): Promise<Claim[]> {
  return loadClaims(ctx, incidentId);
}

/** See `StatePort.getSubscriptions`. Sorted by user, then scope kind, then scope id. */
export async function getSubscriptions(ctx: StateContext, incidentId: string): Promise<Subscription[]> {
  const incident = await ctx.db.selectFrom('incidents').select(['workspace_id', 'surface_id']).where('id', '=', incidentId).executeTakeFirst();
  if (incident === undefined) {
    return [];
  }
  const surfaceId = incident.surface_id;
  const rows = await ctx.db
    .selectFrom('subscriptions')
    .selectAll()
    .where('workspace_id', '=', incident.workspace_id)
    .where((eb) =>
      eb.or([
        eb.and([eb('scope_kind', '=', 'incident'), eb('scope_id', '=', incidentId)]),
        ...(surfaceId !== null ? [eb.and([eb('scope_kind', '=', 'surface'), eb('scope_id', '=', surfaceId)])] : []),
        eb.and([eb('scope_kind', '=', 'all'), eb('scope_id', '=', ALL_SCOPE_ID)]),
      ]),
    )
    .execute();
  return rows.map((r) => rowToSubscription(ctx, r)).sort(bySubscription);
}

/**
 * The incident's escalation scores as A 7 `EscalationScore`s, sorted by intent. Not on the StatePort
 * (B 1 has no reader for this table yet); the signals stage (phase 4) reads it through here.
 */
export async function getEscalationScores(ctx: StateContext, incidentId: string): Promise<EscalationScore[]> {
  return (await loadScores(ctx, incidentId)).map((s) => ({
    incidentId: s.incidentId,
    intent: s.intent,
    uniqueReactors: [...s.reactorIds],
    score: s.score,
    ...(s.stepReached !== undefined ? { ladderStepReached: s.stepReached } : {}),
  }));
}
