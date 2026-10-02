// src/engine/orchestrator.ts: the incident orchestrator (main 14.1) on the WorkflowPort (B 1, ADR 0012).
//
// handleInbound (the request path, within the platform's ack budget): adapter by channel, then
// authenticate, normalize, idempotency (`seenWebhook` on the payload's key, main 14.2), start the
// `incident.process` job, acknowledge. Nothing else runs before the ack.
//
// process (the `incident.process` job): a loop of "read the log, fold it (cursor.ts), run the next
// phase (steps.ts)". Every append passes `expectedSeq`; a conflict re-reads and decides again. A card
// is awaited by parking on `{ kind: 'tap', eventId }` (the incident id is the payload's event id) and
// returning; `handleTap` records `tapped` and resumes; a timeout re-delivers with `{ timedOut: true }`
// and the waiting step applies its default. Jira writes are outbox rows only. `filed { jiraKey }` is
// appended later by the Jira outbox worker (phase 3), which then calls `continueIncident`.
//
// Step order and event sequence per level ("card" = postInteractive, park, and a tap or timeout;
// every card is preceded by `waiting-changed { human }`; [x] = an outbox row in the same transaction):
//
//   every level:  captured, context-assembled (bundle artifact)
//                 scope card (chat channels only): Looks right goes on; Widen or Narrow appends
//                   scope-changed (new bundle version) and shows the card again; timeout = Looks right
//                 resolved, dedupe-checked
//                 dedupe card (only with candidates): Link appends dedupe-decided (link),
//                   linked-to-existing [add-comment on that issue] and stops; Create anyway, Not
//                   related, or timeout appends dedupe-decided, waiting-changed {}
//                 clarify card (only when the ask-back gate passes): clarified (asked), then
//                   clarify-answered, plus resolved (resolvedBy clarify) when the answer names the
//                   surface or component, waiting-changed {}; or, on timeout, waiting-changed {} alone
//   level 0, 2, 3: planned (plan and implementation-request artifacts) [create-issue]; the job ends
//                 (no surface at all: the fallback project, level 0, needs-clarification)
//   level 1:      planned, fix-preview card: Dismiss appends not-a-bug and stops; Fix it, Ticket
//                   only, or timeout appends waiting-changed {} [create-issue]; the job ends
//   after filed:  level 0, and level 1 without Fix it: waiting-changed { human: owner }, status note
//                   (a timeout says nobody tapped Fix it in time)
//                 level 1 after Fix it: waiting-changed {} [transition In Progress], status
//                 level 2, 3: informational fix preview (Stop), waiting-changed {} [transition In
//                   Progress], status
//   early exit:   a resolution signal in the bundle appends resolution-signal with the bundle
//                   (or with a Widen's correction) and stops as not-filed.
//
// Deviations from the main 14.1 shape, each deliberate: the scope preview comes before `resolve`, so a
// widened bundle is resolved once (main 5.5: "before any downstream action"); a level 2 or 3
// transition waits for `filed`, since it needs the Jira key; a `noop` plan appends `not-a-bug`, and a
// `link_existing` plan is filed as a new issue because the dedupe card already decided. Card answers
// are decision events, never `corrected` (ADR 0015).

import type { ApprovalAction, CanonicalIncidentPayload, ChannelSource } from '../contracts/incident.ts';
import type { EventActorRole, TappedChoice, TappedPayload } from '../contracts/events.ts';
import { keySegment, type Job } from '../contracts/jobs.ts';
import { isExpectedSeqConflict } from '../contracts/state.ts';
import { authorize, type DenyReason } from '../policy/authorize.ts';
import { isTimedOut } from '../ports/workflow.ts';
import { foldCursor, nextPhase, pendingCard, type CardKind, type Cursor, type PhaseOptions } from './cursor.ts';
import { currentMap, idempotencyTtlSec, type EngineDeps } from './deps.ts';
import { captureStep, newEvent, payloadOf, runPhase, type StepEnv } from './steps.ts';

export class UnsupportedChannelError extends Error {
  override readonly name = 'UnsupportedChannelError';
  constructor(readonly source: string) {
    super(`no adapter for channel ${source}`);
  }
}

export class UnauthorizedError extends Error {
  override readonly name = 'UnauthorizedError';
  constructor(readonly source: string) {
    super(`request on ${source} failed authentication`);
  }
}

/** The `incident.process` job's data: the incident, and on the first start the payload to capture. */
export interface ProcessJobData {
  incidentId: string;
  payload?: CanonicalIncidentPayload;
}

export function isProcessJobData(v: unknown): v is ProcessJobData {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['incidentId'] === 'string' && o['incidentId'] !== '' && (o['payload'] === undefined || (typeof o['payload'] === 'object' && o['payload'] !== null));
}

/** Singleton key of an incident's process job, so a second start while one is queued adds nothing. */
export function processJobKey(incidentId: string): string {
  return `incident:${keySegment(incidentId)}`;
}

/** A button press on a card, as the adapter's callback hands it over. */
export interface TapInput {
  /** The card's interaction id: the incident's payload event id. */
  eventId: string;
  card: CardKind;
  choice: TappedChoice;
  actor: { id: string; role: EventActorRole };
  /** For approval actions that need a linked GitHub identity (ADR 0007). */
  githubLinked?: boolean;
}

export type TapOutcome =
  | { accepted: true; resumed: boolean }
  | { accepted: false; reason: 'not-pending' | 'invalid-choice' | DenyReason; askOwner?: boolean };

const CHOICES: { readonly [K in CardKind]?: readonly string[] } = {
  'scope-preview': ['looks-right', 'widen', 'narrow'],
  dedupe: ['link', 'create-anyway', 'not-related'],
  'fix-preview': ['approve_fix', 'ticket_only', 'dismiss'],
};

function validChoice(card: CardKind, choice: string): boolean {
  const allowed = CHOICES[card];
  return allowed === undefined ? choice.trim() !== '' : allowed.includes(choice);
}

/** Phases per job delivery before the loop gives up (a normal run takes about ten). */
const MAX_STEPS = 64;
/** Re-reads per tap on `ExpectedSeqConflictError`. */
const MAX_TAP_ATTEMPTS = 8;

export class IncidentOrchestrator {
  readonly deps: EngineDeps;

  constructor(deps: EngineDeps) {
    this.deps = deps;
  }

  /** Registers the `incident.process` handler on the workflow port. */
  register(opts: { concurrency?: number } = {}): void {
    this.deps.workflow.work('incident.process', (job) => this.process(job), opts);
  }

  /** The request path: authenticate, normalize, check idempotency, enqueue, acknowledge (main 14.1). */
  async handleInbound(source: ChannelSource, raw: unknown): Promise<unknown> {
    const adapter = this.deps.adapters.get(source);
    if (adapter === undefined) throw new UnsupportedChannelError(source);
    if (!(await adapter.authenticateRequest(raw))) throw new UnauthorizedError(source);

    const payload = await adapter.normalizePayload(raw);
    const seen = await this.deps.state.seenWebhook(`incident:${source}`, payload.idempotencyKey, idempotencyTtlSec(this.deps, source));
    if (!seen) {
      const data: ProcessJobData = { incidentId: payload.eventId, payload };
      await this.deps.workflow.start('incident.process', data, { singletonKey: processJobKey(payload.eventId) });
    }
    return adapter.acknowledge(raw, payload);
  }

  /**
   * Runs the incident forward from wherever its log says it is. Called by the outbox worker after it
   * appends `filed`, or by anything else that moved the log while no process job was parked.
   */
  continueIncident(incidentId: string): Promise<{ jobId: string }> {
    const data: ProcessJobData = { incidentId };
    return this.deps.workflow.start('incident.process', data, { singletonKey: processJobKey(incidentId) });
  }

  /** The `incident.process` handler. */
  async process(job: Job): Promise<void> {
    if (!isProcessJobData(job.data)) throw new TypeError(`incident.process: unexpected job data ${JSON.stringify(job.data)}`);
    const { incidentId, payload: initial } = job.data;
    const map = await currentMap(this.deps);
    const delivery = { timedOut: job.resumed !== undefined && isTimedOut(job.resumed.result) };

    for (let i = 0; i < MAX_STEPS; i++) {
      const cursor = foldCursor(incidentId, await this.deps.state.read(incidentId));
      const phase = nextPhase(cursor, this.phaseOptions(cursor));
      if (phase.kind === 'done' || phase.kind === 'await-filed') return;
      try {
        if (phase.kind === 'capture') {
          await captureStep({ deps: this.deps, map, job, cursor, delivery }, initial);
          continue;
        }
        const env: StepEnv = { deps: this.deps, map, job, cursor, payload: payloadOf(cursor), delivery };
        const result = await runPhase(env, phase);
        if (result !== 'continue') return;
      } catch (err) {
        if (isExpectedSeqConflict(err)) continue;
        throw err;
      }
    }
    throw new Error(`incident.process: incident ${incidentId} did not settle after ${MAX_STEPS} steps`);
  }

  /**
   * The button handler (B 5): checks that `card` is the one the incident waits on and that the actor
   * may choose `choice`, records `tapped`, and resumes the parked job with the tap. A tap on a card
   * that is no longer waiting (answered, timed out, or replaced) is refused and not recorded.
   */
  async handleTap(tap: TapInput): Promise<TapOutcome> {
    if (!validChoice(tap.card, tap.choice)) return { accepted: false, reason: 'invalid-choice' };
    const incidentId = tap.eventId;
    for (let i = 0; i < MAX_TAP_ATTEMPTS; i++) {
      const cursor = foldCursor(incidentId, await this.deps.state.read(incidentId));
      if (cursor.captured === undefined || pendingCard(nextPhase(cursor, this.phaseOptions(cursor))) !== tap.card) {
        return { accepted: false, reason: 'not-pending' };
      }
      if (tap.card === 'fix-preview') {
        const decision = authorize(
          tap.choice as ApprovalAction,
          { kind: 'human', role: tap.actor.role === 'human' ? 'unknown' : tap.actor.role, githubLinked: tap.githubLinked ?? false },
          { level: cursor.level ?? 1, fixerActive: false },
        );
        if (!decision.allowed) return { accepted: false, reason: decision.reason, ...(decision.askOwner === true ? { askOwner: true } : {}) };
      }
      const tapped: TappedPayload = { eventId: tap.eventId, card: tap.card, choice: tap.choice };
      const source = payloadOf(cursor).source;
      const event = newEvent({ deps: this.deps, cursor }, 'tapped', tapped, {
        actor: tap.actor,
        source: source === 'slack' || source === 'teams' || source === 'cli' ? source : 'agent',
      });
      try {
        await this.deps.state.append(incidentId, [event], cursor.lastSeq);
      } catch (err) {
        if (isExpectedSeqConflict(err)) continue;
        throw err;
      }
      const { resumed } = await this.deps.workflow.resume({ kind: 'tap', eventId: tap.eventId }, tapped);
      return { accepted: true, resumed: resumed > 0 };
    }
    return { accepted: false, reason: 'not-pending' };
  }

  private phaseOptions(cursor: Cursor): PhaseOptions {
    const source = cursor.captured?.payload.source;
    return { scopePreview: source !== undefined && this.deps.context?.get(source)?.reader !== undefined };
  }
}
