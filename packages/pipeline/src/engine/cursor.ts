// Where an incident is, read from its event log alone (ADR 0012: "handlers are idempotent and read
// the incident's event log to find where they were"). `foldCursor` folds the log, with corrections
// merged into the events they correct, and `nextPhase` names the one step the process job runs next.
// The tap handler uses the same two functions to decide whether a card is still waiting.
//
// Card answers are decision events (ADR 0015), and the latest of each wins: `scope-changed` replaces
// the bundle, `dedupe-decided` settles a pending dedupe, `clarify-answered` (or the `waiting-changed {}`
// a timeout appends) ends an ask-back round, and a later `resolved` replaces the resolution.

import type { InteractiveCard } from '../contracts/adapters.ts';
import type {
  AutonomyLevel,
  CapturedPayload,
  ClarifiedPayload,
  ContextAssembledPayload,
  EventActor,
  IncidentEvent,
  UserSideCheckRecord,
  PlannedPayload,
  DedupeDecidedPayload,
  TappedPayload,
} from '../contracts/events.ts';
import type { DedupeResult, Resolution } from '../contracts/incident.ts';
import { INITIAL_STATUS, isTerminalStatus, nextStatus, type LifecycleStatus } from '../lifecycle/machine.ts';
import { claimState, type ClaimHold, type EndedHold, type ReporterClaim } from './claims.ts';

export type CardKind = InteractiveCard['kind'];

export interface Tap {
  seq: number;
  payload: TappedPayload;
  actor?: EventActor;
}

export interface Cursor {
  incidentId: string;
  /** The seq to pass as `expectedSeq` on the next append (0 for an empty log). */
  lastSeq: number;
  status?: LifecycleStatus;
  captured?: { seq: number; payload: CapturedPayload; occurredAt: string };
  assembled?: {
    seq: number;
    payload: ContextAssembledPayload;
    /** Seq of the last change to the bundle: the event itself or the latest `scope-changed`. */
    changedAt: number;
    /** The Widen and Narrow choices `scope-changed` applied, in order. */
    scopeHistory: ('widen' | 'narrow')[];
  };
  /** The latest `resolved`. */
  resolved?: { seq: number; resolution: Resolution };
  /**
   * `dedupe-checked`, with `result.decision` settled by the latest `dedupe-decided` (Link is `link`;
   * Create anyway, Not related, and the timeout default are `create-anyway`).
   */
  dedupe?: { seq: number; result: DedupeResult; decided?: { seq: number; payload: DedupeDecidedPayload } };
  clarified: ClarifyRound[];
  planned?: { seq: number; payload: PlannedPayload };
  /** The planned level, then any later `level-changed`. */
  level?: AutonomyLevel;
  filed?: { seq: number; jiraKey: string };
  /**
   * Seq of the first `stopped` appended while nothing was filed yet (main 15.1: a Stop button on a
   * card, or the trigger reaction removed within 60 s). It ends the process job for good, even when a
   * `create-issue` row already queued lands as `filed` afterwards.
   */
  stoppedBeforeFiling?: number;
  /** Seq of the latest `stopped` newer than `filed` (a Stop between filing and the after-filed step, #206). */
  stoppedAfterFiled?: number;
  linkedTo?: string;
  /** True while the last `waiting-changed` set a wait and no status change has ended it. */
  waiting: boolean;
  /** Seqs of `waiting-changed` events with no `waitingOn`: a wait that ended without a status change. */
  waitEnds: number[];
  /** Seqs of every `waiting-changed` event. */
  waitChanges: number[];
  /** Every `waiting-changed` that set a wait on a person: its seq and who (`waitingOn.who`). */
  humanWaits: { seq: number; who?: string }[];
  taps: Tap[];
  /** A 2.1: the engineer's claim holding the fixer now (claims.ts). */
  hold?: ClaimHold;
  /** The latest hold that ended (`let-agent-take`, or `released` for the holder), with no hold since. */
  holdEnded?: EndedHold;
  /** Claims that hold nothing (a reporter's), in log order. */
  reporterClaims: ReporterClaim[];
}

/** One ask-back round: the `clarified` question and how it ended. */
export interface ClarifyRound {
  seq: number;
  payload: ClarifiedPayload;
  /** The latest `clarify-answered` for this question. */
  answer?: { seq: number; answer: string };
  /** Seq of the `waiting-changed {}` after the question with no answer: the round timed out. */
  endedAt?: number;
}

/** True once a round has an answer or has ended without one (including #47's corrected fields). */
export function roundClosed(round: ClarifyRound): boolean {
  return round.answer !== undefined || round.endedAt !== undefined || round.payload.answer !== undefined || round.payload.timedOut;
}

/** True when a closed round ended with no answer, so the ticket gets `needs-clarification`. */
export function roundUnanswered(round: ClarifyRound): boolean {
  return round.answer === undefined && round.payload.answer === undefined;
}

/** A 5.2: a closed user-side check, as the plan step files it. `answer` is absent when the card timed out. */
export interface UserSideRound {
  seq: number;
  check: UserSideCheckRecord;
  answer?: string;
}

/** The incident's user-side check round (the last `clarified`, when it was one), closed or not. */
export function userSideRound(cursor: Pick<Cursor, 'clarified'>): UserSideRound | undefined {
  const last = cursor.clarified[cursor.clarified.length - 1];
  const check = last?.payload.userSide;
  if (last === undefined || check === undefined) return undefined;
  const answer = last.answer?.answer ?? last.payload.answer;
  return { seq: last.seq, check, ...(answer === undefined ? {} : { answer }) };
}

/** Payloads with every applicable correction merged, stacking in log order (ADR 0014). */
function correctedPayloads(events: readonly IncidentEvent[]): Map<number, Record<string, unknown>> {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const merged = new Map<number, Record<string, unknown>>();
  for (const e of events) {
    if (e.type !== 'corrected') continue;
    const target = bySeq.get(e.payload.correctsSeq);
    if (target === undefined || target.type === 'corrected' || target.seq >= e.seq) continue;
    const payload = { ...(merged.get(target.seq) ?? (target.payload as unknown as Record<string, unknown>)) };
    for (const [key, value] of Object.entries(e.payload.fields)) {
      if (value === null) delete payload[key];
      else payload[key] = value;
    }
    merged.set(target.seq, payload);
  }
  return merged;
}

export function foldCursor(incidentId: string, events: readonly IncidentEvent[]): Cursor {
  const corrected = correctedPayloads(events);
  const cursor: Cursor = { incidentId, lastSeq: 0, clarified: [], waiting: false, waitEnds: [], waitChanges: [], humanWaits: [], taps: [], reporterClaims: [] };
  let status: LifecycleStatus | undefined;
  for (const raw of events) {
    cursor.lastSeq = raw.seq;
    const fixed = corrected.get(raw.seq);
    const e = (fixed === undefined ? raw : { ...raw, payload: fixed }) as IncidentEvent;
    const before = status;
    status = e.type === 'captured' && status === undefined ? INITIAL_STATUS : status === undefined ? undefined : nextStatus(status, e);
    if (status !== before) cursor.waiting = false;
    switch (e.type) {
      case 'captured':
        cursor.captured ??= { seq: e.seq, payload: e.payload, occurredAt: e.occurredAt };
        break;
      case 'context-assembled':
        cursor.assembled ??= { seq: e.seq, payload: e.payload, changedAt: e.seq, scopeHistory: [] };
        break;
      case 'scope-changed':
        if (cursor.assembled !== undefined) {
          const { bundle, includedCount, excludedCount, choice } = e.payload;
          cursor.assembled.payload = { bundle, includedCount, excludedCount };
          cursor.assembled.changedAt = e.seq;
          cursor.assembled.scopeHistory.push(choice);
        }
        break;
      case 'resolved':
        cursor.resolved = { seq: e.seq, resolution: e.payload };
        break;
      case 'dedupe-checked':
        cursor.dedupe ??= { seq: e.seq, result: e.payload };
        break;
      case 'dedupe-decided':
        if (cursor.dedupe !== undefined) {
          const decision = e.payload.decision === 'link' ? 'link' : 'create-anyway';
          cursor.dedupe.result = { ...cursor.dedupe.result, decision };
          cursor.dedupe.decided = { seq: e.seq, payload: e.payload };
        }
        break;
      case 'clarify-answered': {
        const round = cursor.clarified.find((c) => c.seq === e.payload.questionSeq);
        if (round !== undefined) round.answer = { seq: e.seq, answer: e.payload.answer };
        break;
      }
      case 'linked-to-existing':
        cursor.linkedTo ??= e.payload.issueKey;
        break;
      case 'clarified':
        cursor.clarified.push({ seq: e.seq, payload: e.payload });
        break;
      case 'planned':
        if (cursor.planned === undefined) {
          cursor.planned = { seq: e.seq, payload: e.payload };
          cursor.level = e.payload.autonomyLevel;
        }
        break;
      case 'level-changed':
        if (cursor.planned !== undefined) cursor.level = e.payload.to;
        break;
      case 'filed':
        cursor.filed ??= { seq: e.seq, jiraKey: e.payload.jiraKey };
        break;
      case 'stopped':
        if (cursor.filed === undefined) cursor.stoppedBeforeFiling ??= e.seq;
        else cursor.stoppedAfterFiled = e.seq;
        break;
      case 'tapped':
        cursor.taps.push({ seq: e.seq, payload: e.payload, ...(e.actor === undefined ? {} : { actor: e.actor }) });
        break;
      case 'waiting-changed': {
        cursor.waitChanges.push(e.seq);
        cursor.waiting = e.payload.waitingOn !== undefined;
        if (e.payload.waitingOn?.kind === 'human') cursor.humanWaits.push({ seq: e.seq, ...(e.payload.waitingOn.who === undefined ? {} : { who: e.payload.waitingOn.who }) });
        if (e.payload.waitingOn !== undefined) break;
        cursor.waitEnds.push(e.seq);
        // A wait that ends with the last question still open is that question's timeout.
        const last = cursor.clarified[cursor.clarified.length - 1];
        if (last !== undefined && cursor.planned === undefined && !roundClosed(last)) last.endedAt = e.seq;
        break;
      }
      default:
        break;
    }
  }
  if (status !== undefined) cursor.status = status;
  const claims = claimState(events);
  if (claims.hold !== undefined) cursor.hold = claims.hold;
  if (claims.ended !== undefined) cursor.holdEnded = claims.ended;
  cursor.reporterClaims = claims.reporterClaims;
  return cursor;
}

/** The first tap on `card` after `seq`: the answer to the card posted then. Later taps are ignored. */
export function answerAfter(cursor: Cursor, card: CardKind, seq: number): Tap | undefined {
  return cursor.taps.find((t) => t.seq > seq && t.payload.card === card);
}

/** The one step the process job runs next. `answer` is a tap already in the log that the step applies. */
export type Phase =
  | { kind: 'capture' }
  | { kind: 'assemble' }
  | { kind: 'scope'; answer?: Tap }
  | { kind: 'resolve' }
  | { kind: 'dedupe' }
  | { kind: 'dedupe-card'; answer?: Tap }
  | { kind: 'file-confirm'; answer?: Tap }
  | { kind: 'surface-question' }
  | { kind: 'clarify' }
  | { kind: 'clarify-card'; answer?: Tap }
  | { kind: 'plan'; needsClarification: boolean; userSide?: UserSideRound }
  | { kind: 'fix-preview'; answer?: Tap; held?: true }
  | { kind: 'await-filed' }
  | { kind: 'after-filed' }
  | { kind: 'claim-card'; hold: ClaimHold; posted?: number; answer?: Tap }
  | { kind: 'claim-ended'; ended: EndedHold }
  | { kind: 'done' };

export interface PhaseOptions {
  /** A chat reader exists for this incident's channel, so the scope preview runs (main 5.5). */
  scopePreview: boolean;
  /**
   * The incident came from a capture source (Raycast, CLI; main 15.3, 15.4), so after dedupe it shows
   * exactly one lookup card (`capturePhase`) in place of the ask-back. A candidate is no card for a
   * capture: its `dedupe-card` step links at once. Default false.
   */
  capture?: boolean;
}

export function nextPhase(cursor: Cursor, options: PhaseOptions): Phase {
  const { captured, assembled, resolved, dedupe, planned, filed } = cursor;
  if (captured === undefined) return { kind: 'capture' };
  if (cursor.status !== undefined && isTerminalStatus(cursor.status)) return { kind: 'done' };
  // A Stop before filing ends the job: no card stays pending, so a later tap or timeout does nothing.
  if (cursor.stoppedBeforeFiling !== undefined) return { kind: 'done' };
  if (assembled === undefined) return { kind: 'assemble' };

  if (resolved === undefined) {
    if (!options.scopePreview) return { kind: 'resolve' };
    const answer = answerAfter(cursor, 'scope-preview', assembled.changedAt);
    if (answer !== undefined && answer.payload.choice !== 'widen' && answer.payload.choice !== 'narrow') return { kind: 'resolve' };
    return answer === undefined ? { kind: 'scope' } : { kind: 'scope', answer };
  }

  if (dedupe === undefined) return { kind: 'dedupe' };
  if (dedupe.result.decision === 'pending-user') {
    const answer = answerAfter(cursor, 'dedupe', dedupe.seq);
    return answer === undefined ? { kind: 'dedupe-card' } : { kind: 'dedupe-card', answer };
  }

  if (planned === undefined && options.capture === true) return capturePhase(cursor, dedupe, resolved.resolution);

  if (planned === undefined) {
    const last = cursor.clarified[cursor.clarified.length - 1];
    if (last === undefined) return { kind: 'clarify' };
    if (!roundClosed(last)) {
      const answer = answerAfter(cursor, 'clarify', last.seq);
      return answer === undefined ? { kind: 'clarify-card' } : { kind: 'clarify-card', answer };
    }
    // A 5.2: the user-side check took the round. An unanswered check files normally with the check
    // noted; whether a gap is still open (needs-clarification) the plan step decides.
    const userSide = userSideRound(cursor);
    if (userSide !== undefined) return { kind: 'plan', needsClarification: false, userSide };
    return { kind: 'plan', needsClarification: roundUnanswered(last) };
  }

  if (filed === undefined) {
    if (cursor.level === 1 && !cursor.waitEnds.some((s) => s > planned.seq)) {
      const answer = answerAfter(cursor, 'fix-preview', planned.seq);
      if (answer !== undefined) return { kind: 'fix-preview', answer };
      // A 2.1: an engineer's claim replaces the fix preview; the ticket is filed now, ticket only.
      return cursor.hold === undefined ? { kind: 'fix-preview' } : { kind: 'fix-preview', held: true };
    }
    return { kind: 'await-filed' };
  }
  // After filing, the first `waiting-changed` says who the incident waits on; it marks this step done.
  const afterFiled = cursor.waitChanges.find((s) => s > filed.seq);
  if (afterFiled === undefined) return { kind: 'after-filed' };

  // A 2.1: a hold shows the claim card, once per hold; its `waiting-changed` on the claimer marks it
  // posted. A Stop after filing posts no new one.
  const { hold, holdEnded } = cursor;
  if (hold !== undefined) {
    const since = Math.max(hold.seq, filed.seq);
    const posted = cursor.humanWaits.find((w) => w.seq > since && w.who === hold.claimerId)?.seq;
    if (posted === undefined) return cursor.stoppedAfterFiled === undefined ? { kind: 'claim-card', hold } : { kind: 'done' };
    const answer = answerAfter(cursor, 'claimed', posted);
    return answer === undefined ? { kind: 'claim-card', hold, posted } : { kind: 'claim-card', hold, posted, answer };
  }
  // A hold that ended after the after-filed step: the configured level resumes, once (its
  // `waiting-changed` marks it done).
  if (holdEnded !== undefined && holdEnded.seq > afterFiled && !cursor.waitChanges.some((s) => s > holdEnded.seq)) {
    return { kind: 'claim-ended', ended: holdEnded };
  }
  return { kind: 'done' };
}

/**
 * A capture source after dedupe (main 15.3, 15.4). The first response is exactly one of: the
 * link to a tracked issue (handled above, with candidates), `file-confirm` when the surface resolved, or the surface
 * question (a `clarify` round asking `surface`, its options the map's labels) when it did not. File it,
 * a surface answer, or Create anyway with a resolved surface goes on to the plan; Not this surface, or
 * Create anyway with none, asks the surface question. Cancel and every timeout append
 * `capture-cancelled`, which is terminal, so `nextPhase` stops before reaching here again. There is no
 * other ask-back: a capture has no thread to read.
 */
function capturePhase(cursor: Cursor, dedupe: NonNullable<Cursor['dedupe']>, resolution: Resolution): Phase {
  const last = cursor.clarified[cursor.clarified.length - 1];
  if (last !== undefined) {
    if (!roundClosed(last)) {
      const answer = answerAfter(cursor, 'clarify', last.seq);
      return answer === undefined ? { kind: 'clarify-card' } : { kind: 'clarify-card', answer };
    }
    return { kind: 'plan', needsClarification: roundUnanswered(last) };
  }
  if (dedupe.decided !== undefined) {
    return resolution.surfaceId === undefined ? { kind: 'surface-question' } : { kind: 'plan', needsClarification: false };
  }
  if (resolution.surfaceId === undefined) return { kind: 'surface-question' };
  const answer = answerAfter(cursor, 'file-confirm', dedupe.seq);
  return answer === undefined ? { kind: 'file-confirm' } : { kind: 'file-confirm', answer };
}

/** The card a phase is waiting on with no answer yet, which is the only card a tap may answer. */
export function pendingCard(phase: Phase): CardKind | undefined {
  switch (phase.kind) {
    case 'scope':
      return phase.answer === undefined ? 'scope-preview' : undefined;
    case 'dedupe-card':
      return phase.answer === undefined ? 'dedupe' : undefined;
    case 'file-confirm':
      return phase.answer === undefined ? 'file-confirm' : undefined;
    case 'clarify-card':
      return phase.answer === undefined ? 'clarify' : undefined;
    case 'fix-preview':
      return phase.answer === undefined && phase.held !== true ? 'fix-preview' : undefined;
    case 'claim-card':
      return phase.posted !== undefined && phase.answer === undefined ? 'claimed' : undefined;
    default:
      return undefined;
  }
}

/** True when a level 1 incident's fix preview was answered `approve_fix` (the decision `nextPhase` applied). */
export function approvedFix(cursor: Cursor): boolean {
  const planned = cursor.planned;
  if (planned === undefined) return false;
  return answerAfter(cursor, 'fix-preview', planned.seq)?.payload.choice === 'approve_fix';
}
