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
//                 user-side check (A 5.2, clarify/user-side.ts) in place of the gap question, when a
//                   reading's indicator reaches the playbook floor and the gate passes: clarified
//                   (userSide), then clarify-answered; That fixed it adds waiting-changed {}, user-side
//                   and a thread note and stops as not-filed with no Jira row; Still broken, I meant
//                   <env>, or a timeout go on to planned with the check noted on the ticket
//   level 0, 2, 3: planned (plan and implementation-request artifacts) [create-issue]; the job ends
//                 (no surface at all: the fallback project, level 0, needs-clarification)
//   level 1:      planned, fix-preview card: Dismiss appends not-a-bug and stops; Fix it, Ticket
//                   only, or timeout appends waiting-changed {} [create-issue]; the job ends
//   after filed:  level 0, and level 1 without Fix it: waiting-changed { human: owner }, status note
//                   (a timeout says nobody tapped Fix it in time)
//                 level 1 after Fix it: waiting-changed {} [transition In Progress], status
//                 level 2, 3: informational fix preview (Stop), waiting-changed {} [transition In
//                   Progress], status
//   claim (A 2.1, engine/claims.ts): an engineer's `claimed` before the first fixer start holds the
//                 fixer at every level. The plan keeps the configured level; the create payload is
//                   labeled human-claimed and suggests the claimer as assignee; at level 1 the fix
//                   preview is skipped (or, already parked, woken by `handleClaim`) and the ticket is
//                   filed ticket only. After filed, in place of the transition and the fix preview:
//                   [add-labels human-claimed when claimed before filed] [add-comment with the
//                   scout's diagnosis], waiting-changed { human: claimer }, claim card (Let the agent
//                   take it, Not a bug; no default, a timeout parks again). A claim after the
//                   after-filed step, still before the fixer starts, posts the same card then.
//                 Let the agent take it (engineers only) appends let-agent-take; Not a bug appends
//                   not-a-bug [transition done, Won't Do]. When the hold ends (let-agent-take, or
//                   `released` for the holder) the configured level resumes: waiting-changed, and at
//                   levels 2 and 3 (level 1 when let-agent-take ended it) [transition In Progress],
//                   the informational fix preview at 2 and 3, and `deps.startFixer`. `fixer.run`
//                   refuses to start while the hold lasts. A reporter's claim holds nothing: it is
//                   [add-comment "@pat is looking into it."], after filed.
//   capture (raycast, cli; main 15.3, 15.4): no scope card. After dedupe-checked, exactly one
//                 lookup card instead of the ask-back: the dedupe card (Open it is `link`, Create
//                   anyway), file-confirm when the surface resolved (File it, Not this surface,
//                   Cancel), or the surface question (clarified asks surface, every map label as an
//                   option, Cancel) when it did not. File it, a surface answer (clarify-answered,
//                   resolved), or Create anyway with a resolved surface goes on to planned; Not this
//                   surface, or Create anyway without one, asks the surface question. Cancel or a
//                   timeout on any of them appends capture-cancelled and stops as not-filed with no
//                   Jira row. `context.surfaceHint` (`--surface web`) resolves to that surface
//                   (resolvedBy surface-hint) without inference; dedupe and the lookup still run.
//   early exit:   a resolution signal in the bundle appends resolution-signal with the bundle
//                   (or with a Widen's correction) and stops as not-filed.
//   stop:         a `stopped` appended before `filed` (a Stop on a card, or the trigger reaction removed
//                   within 60 s, main 15.1) ends the job with nothing more appended: a parked card's
//                   tap is refused (`not-pending`), its timeout does nothing, and a `filed` from a
//                   create-issue row queued before the stop runs no after-filed step.
//
// Deviations from the main 14.1 shape, each deliberate: the scope preview comes before `resolve`, so a
// widened bundle is resolved once (main 5.5: "before any downstream action"); a level 2 or 3
// transition waits for `filed`, since it needs the Jira key; a `noop` plan appends `not-a-bug`, and a
// `link_existing` plan is filed as a new issue because the dedupe card already decided. Card answers
// are decision events, never `corrected` (ADR 0015).
//
// A pre-filing Stop appends no terminal event (decided in #192): the incident stays `stopped`. B 5 says
// `stopped` is not terminal, no event type means "ended unfiled" (`not-filed` is reached only by
// `resolution-signal`, and only from `captured` or `assembling`), and staying in `stopped` lets a
// create-issue row already queued still land as `filed` (`stopped` accepts it), so its Jira issue is
// tracked rather than orphaned. The fixer's own guard (`stoppedSinceFiled`) does not cover that late
// `filed`; the engine does, since it then never runs the after-filed step whose In Progress transition
// starts the fixer.

import { CAPTURE_CANCEL_CHOICE, FILE_CONFIRM_CHOICES } from '../contracts/adapters.ts';
import { isCaptureSource, type ApprovalAction, type CanonicalIncidentPayload, type ChannelSource } from '../contracts/incident.ts';
import type { EventActorRole, TappedChoice, TappedPayload } from '../contracts/events.ts';
import { keySegment, type Job } from '../contracts/jobs.ts';
import { isExpectedSeqConflict } from '../contracts/state.ts';
import { authorize, type DenyReason } from '../policy/authorize.ts';
import { isTimedOut } from '../ports/workflow.ts';
import { foldCursor, nextPhase, pendingCard, type CardKind, type Cursor, type PhaseOptions } from './cursor.ts';
import { currentMap, idempotencyTtlSec, type EngineDeps } from './deps.ts';
import { captureStep, newEvent, payloadOf, reporterClaimComment, runPhase, type StepEnv } from './steps.ts';

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
  claimed: ['let-agent-take', 'dismiss'],
  'file-confirm': FILE_CONFIRM_CHOICES,
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

  /**
   * A 2.1: whoever appends a claim event (`claimed`, a `comment` with intent `claim`, `let-agent-take`,
   * or `released` with scope `claim`) calls this after the append commits, with the event's seq. A
   * reporter's claim after the after-filed step gets its comment on the ticket here. The process job is
   * woken only where the claim changes what it does next: a parked level 1 fix preview that a hold
   * now replaces, a claim card to post on a filed incident whose job has ended, or a hold that ended
   * while its claim card waited. Anywhere else the job picks the claim up from the log on its own.
   */
  async handleClaim(incidentId: string, seq: number): Promise<{ commented: boolean; woke: boolean }> {
    const cursor = foldCursor(incidentId, await this.deps.state.read(incidentId));
    if (cursor.captured === undefined) return { commented: false, woke: false };
    const commented = await reporterClaimComment({ deps: this.deps, map: await currentMap(this.deps), cursor }, seq);
    const phase = nextPhase(cursor, this.phaseOptions(cursor));
    const wakes =
      (phase.kind === 'fix-preview' && phase.held === true) || (phase.kind === 'claim-card' && phase.posted === undefined) || phase.kind === 'claim-ended';
    if (!wakes) return { commented, woke: false };
    const { resumed } = await this.deps.workflow.resume({ kind: 'tap', eventId: incidentId }, { claimSeq: seq });
    if (resumed === 0) await this.continueIncident(incidentId);
    return { commented, woke: true };
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
          // A 1.4: reactions on the anchor before the incident existed count from now (#288).
          await this.deps.onCaptured?.(incidentId).catch(() => undefined);
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
      // A capture's surface question takes one of its options or Cancel, never free text.
      if (tap.card === 'clarify' && isCaptureSource(cursor.captured.payload.source)) {
        const options = cursor.clarified[cursor.clarified.length - 1]?.payload.options ?? [];
        if (tap.choice !== CAPTURE_CANCEL_CHOICE && !options.includes(tap.choice)) return { accepted: false, reason: 'invalid-choice' };
      }
      if (tap.card === 'fix-preview') {
        const decision = authorize(
          tap.choice as ApprovalAction,
          { kind: 'human', role: tap.actor.role === 'human' ? 'unknown' : tap.actor.role, githubLinked: tap.githubLinked ?? false },
          { level: cursor.level ?? 1, fixerActive: false },
        );
        if (!decision.allowed) return { accepted: false, reason: decision.reason, ...(decision.askOwner === true ? { askOwner: true } : {}) };
      }
      // A 2.1: handing an engineer's claim back to the agent starts a fix, so it takes an engineer.
      if (tap.card === 'claimed' && tap.choice === 'let-agent-take' && tap.actor.role !== 'engineer') {
        return { accepted: false, reason: 'engineer-required' };
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
    return {
      scopePreview: source !== undefined && this.deps.context?.get(source)?.reader !== undefined,
      capture: source !== undefined && isCaptureSource(source),
    };
  }
}
