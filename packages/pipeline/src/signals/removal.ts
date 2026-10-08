// Reaction removal (A 1.6): removing a reaction reverses its effect where reversal is safe.
// A pure module the signal handler calls for a `reaction-removed` signal; it reads the log it is
// given and returns a plan, and appends, stops, and posts nothing itself.
//
// What the handler already does for every removal, and this module does not repeat: it records the
// removal as a `comment` event (`signalSource: 'reaction-removed'`) with the same count as the add, so
// the `escalation_scores` projection takes the reactor and their weight back out (A 1.4) and the
// `subscriptions` projection unsubscribes a `watch` (A 4.4). The plan adds what a comment cannot do.
//
//   claim     `release`: a `released { scope: 'claim' }` event for the reactor, only when they hold a
//             claim (the claims list the handler reads with `getClaims`); the handler then calls the
//             claim hook like any release.
//   watch     `unsubscribe`: nothing to append; the projection does it from the removal comment.
//   accept    on a staging check, `withdraw`: the reactor's verification is withdrawn and a `held` gate
//             event holds any deploy that depended on it. Only when that reactor's accept verified
//             (the log has their `verify` comment on this message) and no other reactor's verification
//             stands. No event un-verifies, so the hold is the record.
//   escalate  `lower`: the score drops through the projection; priority is never lowered ("a bug that
//             stopped getting reactions did not stop being a bug", A 1.4), so a plan never carries a
//             priority change (`lowersPriority` is always false).
//   trigger   within 60 s of the add, `stop`: the existing Stop (main 15.1) belongs to
//             the adapter's `reaction_removed` handling, so the plan says `stop` with `viaAdapter` and
//             carries no event; the handler must not call `stopIncident` a second time. After 60 s, or
//             when the log holds no add of theirs, `removed`.
//   anything else: `removed`, recorded only.
//
// Call it with the log as read before the removal comment is appended.

import type { EventActor, EventPayloads, EventType, IncidentEvent, NewEvent } from '../contracts/events.ts';
import type { Intent, TargetRole } from '../contracts/signals.ts';

/** How long after the trigger a removed reaction still counts as a Stop (main 15.1; the adapter's window). */
export const TRIGGER_STOP_WINDOW_MS = 60_000;

/** What removing a reaction did, beyond the removal comment. */
export type RemovalEffect = 'release' | 'unsubscribe' | 'withdraw' | 'lower' | 'stop' | 'removed';

export interface RemovalSignal {
  intent: Intent;
  actor: EventActor;
  /** The message the reaction was on. */
  target: { messageId: string };
  /** When the reaction was removed (ISO 8601). */
  timestamp: string;
  environment?: string;
}

export interface RemovalInput {
  workspaceId: string;
  incidentId: string;
  signal: RemovalSignal;
  /** The role of the message the reaction was on (`resolveTarget`). */
  role: TargetRole;
  /** The incident's log, oldest first, before the removal comment. */
  log: readonly IncidentEvent[];
  /** The reactors holding a claim now (`getClaims`). */
  claimerIds: readonly string[];
  /** Source stamped on appended events. */
  source: 'slack' | 'teams' | 'jira';
}

export interface RemovalPlan {
  effect: RemovalEffect;
  /** Events to append after the removal comment, in order. */
  events: NewEvent[];
  /** The Stop is the adapter's; the handler must not stop again. Only with `effect: 'stop'`. */
  viaAdapter?: true;
  /** Priority is never lowered by a removal (A 1.4); always false, so a caller can assert it. */
  lowersPriority: false;
}

/** The plan for one removed reaction (see the file header). Pure. */
export function planRemoval(input: RemovalInput): RemovalPlan {
  switch (input.signal.intent) {
    case 'claim':
      return releaseClaim(input);
    case 'watch':
      return plan('unsubscribe');
    case 'accept':
      return input.role === 'staging-check' ? withdrawVerification(input) : plan('removed');
    case 'escalate':
      return plan('lower');
    case 'trigger':
      return withinStopWindow(input) ? { ...plan('stop'), viaAdapter: true } : plan('removed');
    default:
      return plan('removed');
  }
}

function plan(effect: RemovalEffect, events: NewEvent[] = []): RemovalPlan {
  return { effect, events, lowersPriority: false };
}

function newEvent<T extends EventType>(input: RemovalInput, type: T, payload: EventPayloads[T]): NewEvent {
  return {
    workspaceId: input.workspaceId,
    incidentId: input.incidentId,
    type,
    v: 1,
    source: input.source,
    actor: input.signal.actor,
    occurredAt: input.signal.timestamp,
    payload,
  } as unknown as NewEvent;
}

function releaseClaim(input: RemovalInput): RemovalPlan {
  const claimerId = input.signal.actor.id;
  if (!input.claimerIds.includes(claimerId)) return plan('removed');
  return plan('release', [newEvent(input, 'released', { scope: 'claim', claimerId, reason: 'requested' })]);
}

/** Reaction comments of `intent` on this message, oldest first. */
function reactions(input: RemovalInput, intent: Intent): IncidentEvent<'comment'>[] {
  return input.log.filter(
    (e): e is IncidentEvent<'comment'> =>
      e.type === 'comment' &&
      e.payload.intent === intent &&
      e.payload.target?.messageId === input.signal.target.messageId &&
      (e.payload.signalSource === 'reaction' || e.payload.signalSource === 'reaction-removed'),
  );
}

/** Each reactor's latest reaction comment, kept when it is an add (and, with `effect`, had that effect). */
function standing(events: readonly IncidentEvent<'comment'>[], effect?: string): Map<string, IncidentEvent<'comment'>> {
  const latest = new Map<string, IncidentEvent<'comment'>>();
  for (const e of events) if (e.actor !== undefined) latest.set(e.actor.id, e);
  for (const [id, e] of latest) {
    if (e.payload.signalSource !== 'reaction' || (effect !== undefined && e.payload.effect !== effect)) latest.delete(id);
  }
  return latest;
}

function withdrawVerification(input: RemovalInput): RemovalPlan {
  const actorId = input.signal.actor.id;
  const verifiers = standing(reactions(input, 'accept'), 'verify');
  if (!verifiers.delete(actorId) || verifiers.size > 0) return plan('removed');
  const env = input.signal.environment ?? 'staging';
  const who = input.signal.actor.name ?? actorId;
  return plan('withdraw', [newEvent(input, 'held', { kind: 'gate', reason: `verification on ${env} withdrawn by ${who}` })]);
}

function withinStopWindow(input: RemovalInput): boolean {
  const added = standing(reactions(input, 'trigger')).get(input.signal.actor.id);
  if (added === undefined) return false;
  return Date.parse(input.signal.timestamp) - Date.parse(added.occurredAt) <= TRIGGER_STOP_WINDOW_MS;
}
