// Where an incident is, read from its event log alone (ADR 0012: "handlers are idempotent and read
// the incident's event log to find where they were"). `foldCursor` folds the log, with corrections
// merged into the events they correct, and `nextPhase` names the one step the process job runs next.
// The tap handler uses the same two functions to decide whether a card is still waiting.

import type { InteractiveCard } from '../contracts/adapters.ts';
import type {
  AutonomyLevel,
  CapturedPayload,
  ClarifiedPayload,
  ContextAssembledPayload,
  EventActor,
  IncidentEvent,
  PlannedPayload,
  TappedPayload,
} from '../contracts/events.ts';
import type { DedupeResult, Resolution } from '../contracts/incident.ts';
import { INITIAL_STATUS, isTerminalStatus, nextStatus, type LifecycleStatus } from '../lifecycle/machine.ts';

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
    /** Seq of the last change to the bundle: the event itself or its latest correction. */
    changedAt: number;
    /** The Widen and Narrow taps the corrections applied, in order. */
    scopeHistory: ('widen' | 'narrow')[];
  };
  resolved?: { seq: number; resolution: Resolution };
  dedupe?: { seq: number; result: DedupeResult };
  clarified: { seq: number; payload: ClarifiedPayload }[];
  planned?: { seq: number; payload: PlannedPayload };
  /** The planned level, then any later `level-changed`. */
  level?: AutonomyLevel;
  filed?: { seq: number; jiraKey: string };
  linkedTo?: string;
  /** True while the last `waiting-changed` set a wait and no status change has ended it. */
  waiting: boolean;
  /** Seqs of `waiting-changed` events with no `waitingOn`: a wait that ended without a status change. */
  waitEnds: number[];
  /** Seqs of every `waiting-changed` event. */
  waitChanges: number[];
  taps: Tap[];
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
  const cursor: Cursor = { incidentId, lastSeq: 0, clarified: [], waiting: false, waitEnds: [], waitChanges: [], taps: [] };
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
      case 'resolved':
        cursor.resolved ??= { seq: e.seq, resolution: e.payload };
        break;
      case 'dedupe-checked':
        cursor.dedupe ??= { seq: e.seq, result: e.payload };
        break;
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
      case 'tapped':
        cursor.taps.push({ seq: e.seq, payload: e.payload, ...(e.actor === undefined ? {} : { actor: e.actor }) });
        break;
      case 'waiting-changed':
        cursor.waitChanges.push(e.seq);
        cursor.waiting = e.payload.waitingOn !== undefined;
        if (e.payload.waitingOn === undefined) cursor.waitEnds.push(e.seq);
        break;
      case 'corrected': {
        const assembled = cursor.assembled;
        if (assembled !== undefined && e.payload.correctsSeq === assembled.seq) {
          // The bundle as of this correction; the Widen or Narrow it applied is the last scope tap before it.
          assembled.payload = (corrected.get(assembled.seq) ?? assembled.payload) as unknown as ContextAssembledPayload;
          assembled.changedAt = e.seq;
          const applied = lastTap(cursor.taps, 'scope-preview')?.payload.choice;
          if (applied === 'widen') assembled.scopeHistory.push('widen');
          else if (applied === 'narrow') assembled.scopeHistory.push('narrow');
        }
        break;
      }
      default:
        break;
    }
  }
  if (status !== undefined) cursor.status = status;
  // Corrections may follow the event they correct; report each event's final form.
  if (cursor.resolved) cursor.resolved.resolution = (corrected.get(cursor.resolved.seq) ?? cursor.resolved.resolution) as unknown as Resolution;
  if (cursor.dedupe) cursor.dedupe.result = (corrected.get(cursor.dedupe.seq) ?? cursor.dedupe.result) as unknown as DedupeResult;
  cursor.clarified = cursor.clarified.map((c) => ({ seq: c.seq, payload: (corrected.get(c.seq) ?? c.payload) as unknown as ClarifiedPayload }));
  return cursor;
}

function lastTap(taps: readonly Tap[], card: CardKind): Tap | undefined {
  for (let i = taps.length - 1; i >= 0; i--) {
    const t = taps[i];
    if (t?.payload.card === card) return t;
  }
  return undefined;
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
  | { kind: 'clarify' }
  | { kind: 'clarify-card'; answer?: Tap }
  | { kind: 'plan'; needsClarification: boolean }
  | { kind: 'fix-preview'; answer?: Tap }
  | { kind: 'await-filed' }
  | { kind: 'after-filed' }
  | { kind: 'done' };

export interface PhaseOptions {
  /** A chat reader exists for this incident's channel, so the scope preview runs (main 5.5). */
  scopePreview: boolean;
}

export function nextPhase(cursor: Cursor, options: PhaseOptions): Phase {
  const { captured, assembled, resolved, dedupe, planned, filed } = cursor;
  if (captured === undefined) return { kind: 'capture' };
  if (cursor.status !== undefined && isTerminalStatus(cursor.status)) return { kind: 'done' };
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

  if (planned === undefined) {
    const last = cursor.clarified[cursor.clarified.length - 1];
    if (last === undefined) return { kind: 'clarify' };
    if (last.payload.answer === undefined && !last.payload.timedOut) {
      const answer = answerAfter(cursor, 'clarify', last.seq);
      return answer === undefined ? { kind: 'clarify-card' } : { kind: 'clarify-card', answer };
    }
    return { kind: 'plan', needsClarification: last.payload.timedOut };
  }

  if (filed === undefined) {
    if (cursor.level === 1 && !cursor.waitEnds.some((s) => s > planned.seq)) {
      const answer = answerAfter(cursor, 'fix-preview', planned.seq);
      return answer === undefined ? { kind: 'fix-preview' } : { kind: 'fix-preview', answer };
    }
    return { kind: 'await-filed' };
  }
  // After filing, the first `waiting-changed` says who the incident waits on; it marks this step done.
  if (!cursor.waitChanges.some((s) => s > filed.seq)) return { kind: 'after-filed' };
  return { kind: 'done' };
}

/** The card a phase is waiting on with no answer yet, which is the only card a tap may answer. */
export function pendingCard(phase: Phase): CardKind | undefined {
  switch (phase.kind) {
    case 'scope':
      return phase.answer === undefined ? 'scope-preview' : undefined;
    case 'dedupe-card':
      return phase.answer === undefined ? 'dedupe' : undefined;
    case 'clarify-card':
      return phase.answer === undefined ? 'clarify' : undefined;
    case 'fix-preview':
      return phase.answer === undefined ? 'fix-preview' : undefined;
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
