// A 2.1: when a human is already on it, the agent does less. Pure readers of one incident's event log,
// shared by the engine (cursor.ts, steps.ts) and the fixer job (fixer/job.ts), so both decide the
// same way whether a claim holds the fixer.
//
// - A claim holds when it is a `claimed` event whose actor is an engineer (the appender resolves the
//   claimer's map role into `actor.role`) and it arrived before the incident's first `fixer-started`
//   (A 2.1: "between the anchor and the moment the fixer would start"; a later claim is A 2.2,
//   mid-flight, and holds nothing here).
// - One hold at a time: the first holding claim is the hold, and a second claim while it lasts adds
//   nothing to it. `let-agent-take` (the claimer, or anyone on the claim card, hands the fix back) and
//   `released` with scope `claim` for the holder (A 2.4 expiry, or the holder letting go) end it. A
//   later holding claim, still before any fixer start, starts a new hold.
// - Any other claim is a reporter's (A 2.1: "recorded as a comment ... and does not hold the
//   pipeline"): a `claimed` whose actor is not an engineer, or a `comment` with intent `claim`. It
//   holds nothing; the engine writes "@pat is looking into it." on the ticket.

import type { EventActor, IncidentEvent } from '../contracts/events.ts';

export interface ClaimHold {
  /** Seq of the `claimed` event that started the hold. */
  seq: number;
  claimerId: string;
  expiresAt: string;
  actor?: EventActor;
}

export interface EndedHold {
  hold: ClaimHold;
  /** Seq of the event that ended it. */
  seq: number;
  by: 'let-agent-take' | 'released';
}

export interface ClaimState {
  /** The engineer's claim holding the fixer now, if any. */
  hold?: ClaimHold;
  /** The latest hold that ended, when no hold has started since. */
  ended?: EndedHold;
  /** Seq of the first `fixer-started`: no claim at or after it holds. */
  fixerStarted?: number;
  /** Claims that hold nothing (A 2.1: a reporter's claim is a comment), in log order. */
  reporterClaims: ReporterClaim[];
}

export interface ReporterClaim {
  seq: number;
  /** The chat user id of whoever claimed it. */
  claimerId: string;
  actor?: EventActor;
}

/** True for a `claimed` event from an engineer: the only claim that can hold the fixer. */
export function isEngineerClaim(e: IncidentEvent): e is IncidentEvent<'claimed'> {
  return e.type === 'claimed' && e.actor?.role === 'engineer';
}

/** A claim that holds nothing: a non-engineer's `claimed`, or a `comment` with intent `claim` from a non-engineer. */
export function reporterClaimOf(e: IncidentEvent): ReporterClaim | undefined {
  const actor = e.actor === undefined ? {} : { actor: e.actor };
  if (e.type === 'claimed' && e.actor?.role !== 'engineer') return { seq: e.seq, claimerId: e.payload.claimerId, ...actor };
  if (e.type === 'comment' && e.payload.intent === 'claim' && e.actor !== undefined && e.actor.role !== 'engineer') {
    return { seq: e.seq, claimerId: e.actor.id, ...actor };
  }
  return undefined;
}

/** Folds the log into the claim state (see the file header). */
export function claimState(events: readonly IncidentEvent[]): ClaimState {
  const state: ClaimState = { reporterClaims: [] };
  for (const e of events) {
    if (e.type === 'fixer-started') {
      state.fixerStarted ??= e.seq;
      continue;
    }
    const reporter = reporterClaimOf(e);
    if (reporter !== undefined) {
      state.reporterClaims.push(reporter);
      continue;
    }
    if (isEngineerClaim(e)) {
      if (state.hold === undefined && state.fixerStarted === undefined) {
        state.hold = { seq: e.seq, claimerId: e.payload.claimerId, expiresAt: e.payload.expiresAt, ...(e.actor === undefined ? {} : { actor: e.actor }) };
        delete state.ended;
      }
      continue;
    }
    const hold = state.hold;
    if (hold === undefined) continue;
    const ends =
      (e.type === 'let-agent-take' && e.payload.claimerId === hold.claimerId) ||
      (e.type === 'released' && e.payload.scope === 'claim' && e.payload.claimerId === hold.claimerId);
    if (ends) {
      state.ended = { hold, seq: e.seq, by: e.type === 'let-agent-take' ? 'let-agent-take' : 'released' };
      delete state.hold;
    }
  }
  return state;
}

/** The engineer's claim holding the fixer now, if any. */
export function claimHold(events: readonly IncidentEvent[]): ClaimHold | undefined {
  return claimState(events).hold;
}
