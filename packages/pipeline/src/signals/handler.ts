// The signal handler (A 1.3, A 1.5, A 2.1, A 4.4; #288): applies one classified reaction or short
// message to the incident it lands on.
//
// `handleSignal(deps, signal)` resolves the target first (`resolveTarget`, #287): a message Snapwing
// posted (its role), an incident's anchor, or nothing. A message signal (the lexicon or the LLM pass)
// with no resolved target is dropped: A 1.2 applies them only inside an incident's thread, never to
// arbitrary channel messages. A reaction on a message with no incident yet is stored (below).
//
// Every signal on an incident appends one `comment` event (A 4.2 `comment:<intent>`) recording it:
// the intent, the target, the raw emoji or text, the deep link, and `effect`, what the handler did.
// The `escalation_scores` and `subscriptions` projections fold it, and `outbox/jira.ts` and
// `outbox/github.ts` turn it into the attribution comment (A 1.5). Where the intent changes state,
// the event that changes it goes in the same append (one `expectedSeq`, the incident row's
// `lastSeq`, so the decision is made on the status the append lands on; a conflict decides again):
//
//   claim      an engineer on the anchor or a Fix Preview Card (A 1.3 `hold`): `claimed` with the
//              actor's map role and `expiresAt` from `claims.expiry`. A reporter's claim is the comment
//              alone (A 2.1 "recorded as a comment"; the engine writes "@pat is looking into it."). Then
//              `IncidentOrchestrator.handleClaim(incident, seq)` (#291), which wakes the engine where
//              the claim changes what it does next. A claim on any other message is recorded only.
//   release    from someone with a claim row: `released { scope: 'claim' }`, then `handleClaim`.
//   stop       `stopIncident` (fixer/stop.ts) with the raw text as the reason, when the Stop button
//              would be allowed (`authorize`); the comment follows it.
//   not-a-bug  from an engineer or the incident's reporter, and an engineer's reject on a Fix Preview
//              Card: `not-a-bug` where the lifecycle accepts it. A filed issue is closed as Won't Do in
//              the same transaction (as the claim card does); before filing a queued create-issue row is
//              dropped (as a Stop does).
//   watch      the comment alone: the `subscriptions` projection subscribes the actor (A 4.4).
//   accept, reject: by the A 1.3 matrix (`resolveSignal`):
//              verify   on a staging check while the incident is on staging: `verified { env }`.
//              reopen   on a staging check while the incident is on staging: the rejection is stored as
//                       a `review` artifact (`ReviewVerdict`, as Request changes does) and the fixer is
//                       re-enqueued with it at the next attempt (level 1 and up). The comment carries
//                       `effect: 'reopen'`, which `outbox/jira.ts` turns into the In Progress transition;
//                       the fixer's start moves the lifecycle from `deployed:staging` to `fixing`.
//              fix-tap, looks-right, link, create-new: the same as tapping the card's button
//                       (`handleTap`), only while that card waits.
//              agree, confirm, dispute (the anchor): counted (A 1.4) and recorded.
//              review-note, approve, changes-requested, rescope, ack, reject-stage, comment: recorded,
//                       which writes the attribution comment on the ticket and the PR (A 1.3: "Approved
//                       in Slack by Dana"). Nobody's reaction merges or approves anything here.
//   trigger, escalate: counted (A 1.4); starting the pipeline is the adapter's trigger path.
//
// Counting (A 1.4): trigger and escalate anywhere, accept on the anchor, and reject on the anchor from
// engineers carry `count { weight, windowEndsAt }`, frozen at record time (reporter, engineer, or owner
// of the surface weight from the playbook; window from the incident's `openedAt`). A signal after the
// window is recorded but not counted. A removed reaction (`reaction-removed`) is recorded with the
// same count and no attribution, so the projections take the reactor back out; its other reversals
// are A 1.6 (`planRemoval`, signals/removal.ts, #289, wired in #348): the plan is made on the log as
// read before the removal comment and the claims (`getClaims`), the comment records its `effect`, and
// its events (a `released`, a `held` gate) go after the comment in the same append. A released claim
// then calls `handleClaim` like any release. A trigger removed within 60 s is the adapter's Stop
// (`viaAdapter`), so the handler never calls `stopIncident` for it. After a counted signal commits,
// `escalation.evaluate` (signals/score.ts, #290) walks the reaction ladder; adoption evaluates once,
// after every stored signal is recorded.
//
// Before the incident exists (A 1.4 last paragraph): a reaction on a message with no incident is
// stored in the cache under the message, one `setIfAbsent` slot per signal (so concurrent reactions
// never overwrite each other), for the playbook's counting window. `adoptPendingSignals` (the engine
// calls it once `captured` commits, `EngineDeps.onCaptured`) records them on the new incident as if
// they had landed on its anchor: the latest signal per person and intent, a removal cancelling the
// add, and only the intents that mean something before anyone acted (trigger, escalate, accept,
// reject, claim, watch). A stop, release, or not-a-bug on a message nobody had reported yet has
// nothing to act on and is dropped. Adoption runs once per anchor (a `setIfAbsent` marker); a signal
// stored while the incident was being created is applied directly when the target resolves right
// after storing it, and a duplicate from that race counts once (unique reactors).

import { PLAYBOOK_INTENTS, type Playbook } from '../config/playbook.ts';
import type { ArtifactRef, CommentPayload, EventActor, EventPayloads, EventType, IncidentEvent, NewEvent } from '../contracts/events.ts';
import type { FixerRunData } from '../contracts/jobs.ts';
import type { IncidentActor } from '../contracts/incident.ts';
import type { Intent, SignalEvent, TargetRole } from '../contracts/signals.ts';
import { isExpectedSeqConflict, type IncidentView, type OutboxItem } from '../contracts/state.ts';
import type { TapInput, TapOutcome } from '../engine/orchestrator.ts';
import type { StopInput, StopOutcome } from '../fixer/stop.ts';
import { isTerminalStatus, isValidTransition } from '../lifecycle/machine.ts';
import type { MapPerson, WorkspaceMap } from '../map/types.ts';
import { authorize } from '../policy/authorize.ts';
import type { CachePort } from '../ports/cache.ts';
import type { StatePort } from '../ports/state.ts';
import type { ReviewVerdict } from '../review/verdict.ts';
import { jiraCreateBatchKey, jiraFieldBatchKey, JIRA_DONE, type TransitionRow } from '../state/projections/outbox/jira.ts';
import { parseDuration } from '../util/duration.ts';
import { ulid } from '../util/ulid.ts';
import { planRemoval, type RemovalEffect } from './removal.ts';
import { resolveSignal, resolveTarget, type MessageRef, type SignalEffect } from './target.ts';

/** The resolution a filed issue closes with on `not-a-bug` (the engine's claim card uses the same). */
export const NOT_A_BUG_RESOLUTION = "Won't Do";

/** Pending signals kept per message before an incident exists. */
export const PENDING_SLOTS = 64;

/** How long the adoption marker lives: longer than any counting window. */
const ADOPTED_TTL_SEC = 7 * 24 * 60 * 60;

/** Re-reads per signal on `ExpectedSeqConflictError`. */
const MAX_APPEND_ATTEMPTS = 8;

/** The intents adoption applies to a new incident (see the file header). */
const ADOPTABLE: ReadonlySet<Intent> = new Set<Intent>(['trigger', 'escalate', 'accept', 'reject', 'claim', 'watch']);

/** The engine calls the handler makes (`IncidentOrchestrator`). */
export interface SignalEngine {
  handleClaim(incidentId: string, seq: number): Promise<unknown>;
  handleTap(tap: TapInput): Promise<TapOutcome>;
}

export interface SignalDeps {
  /** The install's workspace (single tenant), stamped on every event and row. */
  workspaceId: string;
  /** The store `openState` returned: target resolution reads the `bot_messages` projection. */
  state: StatePort;
  /** Holds signals on a message no incident owns yet. */
  cache: CachePort;
  /** The loaded playbook, or a getter for the current one (hot reload, #284). */
  playbook: Playbook | (() => Playbook | Promise<Playbook>);
  /** The workspace map, for the surface owner's weight (A 1.4). Absent: nobody weighs as an owner. */
  map?: WorkspaceMap | (() => Promise<WorkspaceMap>);
  engine: SignalEngine;
  /** `stopIncident` from fixer/stop.ts, bound to its FixerDeps. */
  stopIncident: (input: StopInput) => Promise<StopOutcome>;
  /** `startFixer` from fixer/job.ts, bound to its workflow. */
  startFixer: (input: FixerRunData) => Promise<unknown>;
  /** The A 1.4 reaction ladder (`createReactionEscalation`, signals/score.ts). Absent: no ladder runs. */
  escalation?: { evaluate(incidentId: string): Promise<unknown> };
  clock: () => Date;
}

/**
 * A classified signal as the adapter hands it over: A 7's `SignalEvent` with the message's channel in
 * place of the target role, which the handler resolves. For a reaction the target is the message
 * reacted to; for a message signal it is the root of the thread the message was posted in.
 */
export interface SignalInput extends Omit<SignalEvent, 'target' | 'platform' | 'incidentId'> {
  platform: 'slack' | 'teams';
  target: { channel: string; messageId: string };
  /** A permalink to the reaction's message or the signal message, for the attribution comment. */
  deepLink?: string;
  /** The actor has a linked GitHub identity (main 11.2); gates the PR card effects. */
  githubLinked?: boolean;
}

/** What the handler did, as `CommentPayload.effect` records it. */
export type SignalAction =
  | SignalEffect
  | 'count'
  | 'release'
  | 'stop'
  | 'watch'
  | RemovalEffect;

export type SignalOutcome =
  | { handled: false; reason: 'no-intent' | 'low-confidence' | 'no-target' | 'unknown-incident' }
  /** A reaction on a message with no incident: stored for adoption (false when every slot was taken). */
  | { handled: false; reason: 'pending'; stored: boolean }
  | {
      handled: true;
      incidentId: string;
      role: TargetRole;
      effect: SignalAction;
      /** Seq of the recorded `comment` event. */
      seq: number;
      /** Types of the events appended, in order. */
      appended: EventType[];
    };

/** Applies one signal (see the file header). */
export async function handleSignal(deps: SignalDeps, signal: SignalInput): Promise<SignalOutcome> {
  if (signal.intent === 'none') return { handled: false, reason: 'no-intent' };
  const playbook = await playbookOf(deps);
  if (signal.source === 'message' && signal.confidence < playbook.signals.lexicon.confidenceFloor) return { handled: false, reason: 'low-confidence' };

  const ref: MessageRef = { platform: signal.platform, channel: signal.target.channel, messageId: signal.target.messageId };
  let target = await resolveTarget(deps.state, ref);
  if (target === null) {
    if (signal.source === 'message') return { handled: false, reason: 'no-target' };
    const stored = await storePending(deps, playbook, ref, signal);
    // The incident may have been created while this was stored, after adoption read the slots.
    target = await resolveTarget(deps.state, ref);
    if (target === null) return { handled: false, reason: 'pending', stored };
  } else if (target.role === 'anchor') {
    // A fallback for an engine that never called `adoptPendingSignals` (one cache write when it did).
    await adoptPendingSignals(deps, target.incidentId);
  }
  return applySignal(deps, playbook, signal, target.incidentId, target.role);
}

/**
 * Records the signals stored on the incident's anchor before it existed (see the file header). Call
 * once the `captured` event commits; later calls for the same anchor do nothing. Resolves to the
 * number applied.
 */
export async function adoptPendingSignals(deps: SignalDeps, incidentId: string): Promise<number> {
  const incident = await deps.state.getIncident(incidentId);
  if (incident === null || incident.channelId === undefined || incident.anchorId === undefined) return 0;
  if (incident.source !== 'slack' && incident.source !== 'teams') return 0;
  const ref: MessageRef = { platform: incident.source, channel: incident.channelId, messageId: incident.anchorId };
  if (!(await deps.cache.setIfAbsent(adoptedKey(ref), incidentId, ADOPTED_TTL_SEC))) return 0;

  const stored: SignalInput[] = [];
  for (let n = 0; n < PENDING_SLOTS; n++) {
    const raw = await deps.cache.get(pendingKey(ref, n));
    const signal = raw === null ? undefined : parsePending(raw);
    if (signal !== undefined) stored.push(signal);
  }
  const playbook = await playbookOf(deps);
  let applied = 0;
  for (const signal of latestPerPerson(stored)) {
    const outcome = await applySignal(deps, playbook, signal, incidentId, 'anchor', false);
    if (outcome.handled) applied++;
  }
  // Every adopted reaction counts at once: the ladder jumps straight to the step they reach.
  if (applied > 0) await escalate(deps, incidentId);
  return applied;
}

// Applying ----------------------------------------------------------------------------------------

interface Decision {
  effect: SignalAction;
  /** Events after the comment, in the same append. */
  events?: NewEvent[];
  /** Rows enqueued in the append's transaction. */
  outbox?: OutboxItem[];
  /** Outbox batch keys dropped (target jira) in the append's transaction. */
  drop?: string[];
  /** A removal's Stop is the adapter's (`RemovalPlan.viaAdapter`). */
  viaAdapter?: true;
}

async function applySignal(
  deps: SignalDeps,
  playbook: Playbook,
  signal: SignalInput,
  incidentId: string,
  role: TargetRole,
  evaluate = true,
): Promise<SignalOutcome> {
  const unknown = { handled: false, reason: 'unknown-incident' } as const;
  if ((await deps.state.getIncident(incidentId)) === null) return unknown;
  const actor = actorOf(signal.actor);
  const removed = signal.source === 'reaction-removed';

  // Side effects that are not appends of ours run first; the comment then records what they did.
  let pre: SignalAction | undefined;
  if (!removed) pre = await sideEffect(deps, signal, incidentId, role, playbook);

  let reopenReview: ArtifactRef | undefined;
  for (let attempt = 1; ; attempt++) {
    const incident = await deps.state.getIncident(incidentId);
    if (incident === null) return unknown;
    const decision: Decision = removed
      ? await removal(deps, signal, incident, role)
      : pre !== undefined
        ? { effect: pre }
        : await decide(deps, playbook, signal, incident, role);
    if (decision.effect === 'reopen' && reopenReview === undefined) reopenReview = await putRejection(deps, incidentId, signal);
    const count = await countFor(deps, playbook, signal, incident, role);
    const comment = commentEvent(deps, incidentId, signal, actor, role, decision.effect, count);
    const events: NewEvent[] = [comment, ...(decision.events ?? [])];
    try {
      const { seq } = await deps.state.transaction(async (tx) => {
        for (const key of decision.drop ?? []) await tx.dropOutbox('jira', key);
        for (const row of decision.outbox ?? []) await tx.enqueueOutbox(row);
        return tx.append(incidentId, events, incident.lastSeq);
      });
      const first = seq - events.length + 1;
      await afterAppend(deps, signal, incident, decision, seq, reopenReview);
      if (evaluate && count !== undefined && !removed) await escalate(deps, incidentId);
      return { handled: true, incidentId, role, effect: decision.effect, seq: first, appended: events.map((e) => e.type) };
    } catch (err) {
      if (!isExpectedSeqConflict(err) || attempt >= MAX_APPEND_ATTEMPTS) throw err;
    }
  }
}

/**
 * The effects that call another component before the comment is recorded: a Stop (stopIncident
 * appends `stopped` itself) and the card taps (handleTap appends `tapped` and resumes the job).
 * Undefined when the signal is not one of those; `comment` when it was and nothing happened.
 */
async function sideEffect(deps: SignalDeps, signal: SignalInput, incidentId: string, role: TargetRole, playbook: Playbook): Promise<SignalAction | undefined> {
  if (signal.intent === 'stop') {
    const incident = await deps.state.getIncident(incidentId);
    if (incident === null || !stopAllowed(incident, signal.actor)) return 'comment';
    const reason = signal.raw.trim();
    const outcome = await deps.stopIncident({ incidentId, actor: actorOf(signal.actor), source: signal.platform, ...(reason === '' ? {} : { reason }) });
    return outcome.stopped ? 'stop' : 'comment';
  }
  const effect = resolveSignal(signal.intent, role, signal.actor.role, {
    playbook: { reactionsAsButtons: playbook.signals.reactionsAsButtons, reactionsAsApproval: playbook.signals.reactionsAsApproval },
    githubLinked: signal.githubLinked === true,
  });
  const tap = effect === undefined ? undefined : TAPS[effect];
  if (tap === undefined) return undefined;
  const outcome = await deps.engine.handleTap({
    eventId: incidentId,
    card: tap.card,
    choice: tap.choice,
    actor: { id: signal.actor.id, role: signal.actor.role },
    ...(signal.githubLinked === undefined ? {} : { githubLinked: signal.githubLinked }),
  });
  return outcome.accepted ? (effect as SignalAction) : 'comment';
}

/** A 1.3 effects that are a card's button. */
const TAPS: Partial<Record<SignalEffect, { card: TapInput['card']; choice: TapInput['choice'] }>> = {
  'fix-tap': { card: 'fix-preview', choice: 'approve_fix' },
  'looks-right': { card: 'scope-preview', choice: 'looks-right' },
  link: { card: 'dedupe', choice: 'link' },
  'create-new': { card: 'dedupe', choice: 'create-anyway' },
};

/** What a signal does to `incident`, decided on the row the append will land on. */
async function decide(deps: SignalDeps, playbook: Playbook, signal: SignalInput, incident: IncidentView, role: TargetRole): Promise<Decision> {
  const actor = actorOf(signal.actor);
  const at = signal.timestamp;
  const ev = <T extends EventType>(type: T, payload: EventPayloads[T]): NewEvent =>
    ({ workspaceId: deps.workspaceId, incidentId: incident.id, type, v: 1, source: signal.platform, actor, occurredAt: at, payload }) as unknown as NewEvent;

  switch (signal.intent) {
    case 'trigger':
    case 'escalate':
      return { effect: 'count' };
    case 'watch':
      return { effect: 'watch' };
    case 'claim': {
      const effect = resolveSignal('claim', role, signal.actor.role);
      if (effect !== 'hold') return { effect: 'comment' };
      const expiresAt = new Date(Date.parse(at) + parseDuration(playbook.claims.expiry)).toISOString();
      const claimerEmail = await emailOf(deps, signal);
      return { effect: 'hold', events: [ev('claimed', { claimerId: signal.actor.id, expiresAt, ...(claimerEmail === undefined ? {} : { claimerEmail }) })] };
    }
    case 'release': {
      const claims = await deps.state.getClaims(incident.id);
      if (!claims.some((c) => c.claimerId === signal.actor.id)) return { effect: 'comment' };
      return { effect: 'release', events: [ev('released', { scope: 'claim', claimerId: signal.actor.id, reason: 'requested' })] };
    }
    case 'not-a-bug':
      return notABug(deps, signal, incident, ev);
    case 'accept':
    case 'reject': {
      const effect = resolveSignal(signal.intent, role, signal.actor.role, {
        playbook: { reactionsAsButtons: playbook.signals.reactionsAsButtons, reactionsAsApproval: playbook.signals.reactionsAsApproval },
        githubLinked: signal.githubLinked === true,
      });
      switch (effect) {
        case undefined:
          return { effect: 'comment' };
        case 'verify':
          if (incident.status !== 'deployed:staging') return { effect: 'comment' };
          return { effect: 'verify', events: [ev('verified', { env: signal.environment ?? 'staging' })] };
        case 'reopen':
          return { effect: incident.status === 'deployed:staging' ? 'reopen' : 'comment' };
        case 'not-a-bug':
          return notABug(deps, signal, incident, ev);
        default:
          // The taps ran in `sideEffect`; everything else is recorded with its meaning.
          return { effect: TAPS[effect] === undefined ? effect : 'comment' };
      }
    }
    default:
      return { effect: 'comment' };
  }
}

function notABug(deps: SignalDeps, signal: SignalInput, incident: IncidentView, ev: (type: 'not-a-bug', payload: EventPayloads['not-a-bug']) => NewEvent): Decision {
  const allowed = signal.actor.role === 'engineer' || (incident.reporterId !== undefined && incident.reporterId === signal.actor.id);
  if (!allowed || !fits(incident, 'not-a-bug')) return { effect: 'comment' };
  const raw = signal.raw.trim();
  const event = ev('not-a-bug', { reason: `marked not a bug in ${platformName(signal.platform)} by ${personLabel(signal.actor)}${raw === '' ? '' : `: ${raw}`}` });
  const issueKey = incident.jiraKey;
  if (issueKey === undefined) return { effect: 'not-a-bug', events: [event], drop: [jiraCreateBatchKey(incident.id)] };
  const close: TransitionRow = { issueKey, to: JIRA_DONE, resolution: NOT_A_BUG_RESOLUTION };
  const now = deps.clock();
  const row: OutboxItem = {
    id: ulid(now.getTime()),
    workspaceId: deps.workspaceId,
    target: 'jira',
    incidentId: incident.id,
    op: 'transition',
    payload: { ...close },
    batchKey: jiraFieldBatchKey(incident.id, 'status'),
    attempts: 0,
    nextAttempt: now.toISOString(),
    createdAt: now.toISOString(),
  };
  return { effect: 'not-a-bug', events: [event], outbox: [row] };
}

/**
 * A removed reaction (A 1.6): the plan for it, on the log as read before the removal comment and the
 * claims held now. Its events go after the comment in the same append.
 */
async function removal(deps: SignalDeps, signal: SignalInput, incident: IncidentView, role: TargetRole): Promise<Decision> {
  const [log, claims] = await Promise.all([deps.state.read(incident.id), deps.state.getClaims(incident.id)]);
  const plan = planRemoval({
    workspaceId: deps.workspaceId,
    incidentId: incident.id,
    signal: {
      intent: signal.intent,
      actor: actorOf(signal.actor),
      target: { messageId: signal.target.messageId },
      timestamp: signal.timestamp,
      ...(signal.environment === undefined ? {} : { environment: signal.environment }),
    },
    role,
    log,
    claimerIds: claims.map((c) => c.claimerId),
    source: signal.platform,
  });
  return { effect: plan.effect, events: plan.events, ...(plan.viaAdapter === true ? { viaAdapter: true as const } : {}) };
}

/** After the append commits: the claim hook (#291), a removal's release or Stop, and the reopened fixer. */
async function afterAppend(deps: SignalDeps, signal: SignalInput, incident: IncidentView, decision: Decision, seq: number, review: ArtifactRef | undefined): Promise<void> {
  if (signal.source === 'reaction-removed') {
    if (decision.effect === 'release') await deps.engine.handleClaim(incident.id, seq);
    // A trigger removed within 60 s is the adapter's Stop (#148): never a second one here.
    else if (decision.effect === 'stop' && decision.viaAdapter !== true) await deps.stopIncident({ incidentId: incident.id, actor: actorOf(signal.actor), source: signal.platform });
    return;
  }
  if (signal.intent === 'claim' || decision.effect === 'release') {
    await deps.engine.handleClaim(incident.id, seq);
    return;
  }
  if (decision.effect === 'reopen' && review !== undefined && (incident.autonomyLevel ?? 0) >= 1) {
    const log = await deps.state.read(incident.id);
    await deps.startFixer({ incidentId: incident.id, attempt: nextAttempt(log), reviewArtifact: review });
  }
}

/** The reaction ladder after a counted signal; best effort, since the signal is recorded already. */
async function escalate(deps: SignalDeps, incidentId: string): Promise<void> {
  if (deps.escalation === undefined) return;
  try {
    await deps.escalation.evaluate(incidentId);
  } catch (err) {
    console.warn(`signals: incident ${incidentId}: reaction escalation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The rejection as the prior review the fixer reads (`SNAPWING_PRIOR_REVIEW_FILE`), like Request changes. */
async function putRejection(deps: SignalDeps, incidentId: string, signal: SignalInput): Promise<ArtifactRef> {
  const raw = signal.raw.trim();
  const said = signal.source === 'message' && raw !== '' ? `: "${raw}"` : '';
  const verdict: ReviewVerdict = {
    verdict: 'request-changes',
    reasons: [
      `${personLabel(signal.actor)} checked the fix on ${signal.environment ?? 'staging'} and says it does not work${said}. Find out why the merged change did not fix the reported problem, and fix it.`,
    ],
    constraintViolations: [],
  };
  const put = await deps.state.putArtifact({
    workspaceId: deps.workspaceId,
    incidentId,
    kind: 'review',
    contentType: 'application/json',
    body: JSON.stringify(verdict),
    createdBy: signal.actor.id,
  });
  return { artifactId: put.id, version: put.version };
}

/** One more than the highest fixer attempt since the latest `filed`. */
function nextAttempt(log: readonly IncidentEvent[]): number {
  let filed = 0;
  for (const e of log) if (e.type === 'filed') filed = e.seq;
  let max = 0;
  for (const e of log) if (e.seq > filed && e.type === 'fixer-started') max = Math.max(max, e.payload.attempt);
  return max + 1;
}

/** The Stop button's rule (`authorize('stop')`); before planning there is no level yet, and a stop is allowed. */
function stopAllowed(incident: IncidentView, actor: IncidentActor): boolean {
  if (isTerminalStatus(incident.status)) return false;
  const level = incident.autonomyLevel;
  if (level === undefined) return true;
  const fixerActive = FIXER_ACTIVE.has(incident.status);
  return authorize('stop', { kind: 'human', role: actor.role, githubLinked: false }, { level, fixerActive }).allowed;
}

const FIXER_ACTIVE: ReadonlySet<string> = new Set(['fixing', 'fixing-retry', 'in-review', 'in-review-retry', 'ci', 'ci-retry', 'mergeable', 'held']);

/** True when the lifecycle accepts an event of `type` in the incident's status. */
function fits(incident: IncidentView, type: EventType): boolean {
  return isValidTransition(incident.status, { type, payload: {} } as unknown as IncidentEvent);
}

// Counting (A 1.4) --------------------------------------------------------------------------------

async function countFor(deps: SignalDeps, playbook: Playbook, signal: SignalInput, incident: IncidentView, role: TargetRole): Promise<CommentPayload['count']> {
  const counted =
    signal.intent === 'trigger' ||
    signal.intent === 'escalate' ||
    (signal.intent === 'accept' && role === 'anchor') ||
    (signal.intent === 'reject' && role === 'anchor' && signal.actor.role === 'engineer');
  if (!counted) return undefined;
  const windowEndsAt = new Date(Date.parse(incident.openedAt) + parseDuration(playbook.weights.window)).toISOString();
  if (Date.parse(signal.timestamp) > Date.parse(windowEndsAt)) return undefined;
  const { weights } = playbook;
  const weight = (await isSurfaceOwner(deps, signal, incident)) ? weights.owner : signal.actor.role === 'engineer' ? weights.engineer : weights.reporter;
  return { weight, windowEndsAt };
}

/** The actor's email in the workspace map (the Jira assignee of a claim), or undefined when there is none. */
async function emailOf(deps: SignalDeps, signal: SignalInput): Promise<string | undefined> {
  if (deps.map === undefined) return undefined;
  const map = typeof deps.map === 'function' ? await deps.map() : deps.map;
  const person = map.people.find((p) => (signal.platform === 'slack' ? p.slackId : p.teamsId) === signal.actor.id);
  const email = person?.email?.trim();
  return email === undefined || email === '' ? undefined : email;
}

/** The reactor owns the incident's surface in the map, or is its resolved owner. */
async function isSurfaceOwner(deps: SignalDeps, signal: SignalInput, incident: IncidentView): Promise<boolean> {
  if (deps.map === undefined) return false;
  const map = typeof deps.map === 'function' ? await deps.map() : deps.map;
  const person: MapPerson | undefined = map.people.find((p) => (signal.platform === 'slack' ? p.slackId : p.teamsId) === signal.actor.id);
  if (person === undefined) return false;
  if (incident.ownerRef !== undefined && person.handle === incident.ownerRef) return true;
  return incident.surfaceId !== undefined && person.owns.some((o) => o.surface === incident.surfaceId);
}

// Events ------------------------------------------------------------------------------------------

function commentEvent(
  deps: SignalDeps,
  incidentId: string,
  signal: SignalInput,
  actor: EventActor,
  role: TargetRole,
  effect: SignalAction,
  count: CommentPayload['count'],
): NewEvent<'comment'> {
  const payload: CommentPayload = {
    intent: signal.intent,
    platform: signal.platform,
    signalSource: signal.source,
    target: { role, messageId: signal.target.messageId },
    confidence: signal.confidence,
    raw: signal.raw,
    effect,
    ...(signal.environment === undefined ? {} : { environment: signal.environment }),
    ...(count === undefined ? {} : { count }),
    ...(signal.deepLink === undefined ? {} : { deepLink: signal.deepLink }),
    ...(actor.name === undefined ? {} : { actorName: actor.name }),
  };
  return { workspaceId: deps.workspaceId, incidentId, type: 'comment', v: 1, source: signal.platform, actor, occurredAt: signal.timestamp, payload };
}

/** The map role is the event's `actor.role` (#291: only an engineer's `claimed` holds the fixer). */
function actorOf(actor: IncidentActor): EventActor {
  const name = actor.name.trim();
  return { id: actor.id, role: actor.role, ...(name === '' ? {} : { name }) };
}

function personLabel(actor: IncidentActor): string {
  const name = actor.name.trim();
  return `@${name === '' ? actor.id : name}`;
}

function platformName(platform: SignalInput['platform']): string {
  return platform === 'slack' ? 'Slack' : 'Teams';
}

async function playbookOf(deps: SignalDeps): Promise<Playbook> {
  return typeof deps.playbook === 'function' ? deps.playbook() : deps.playbook;
}

// Pending signals ---------------------------------------------------------------------------------

function refKey(ref: MessageRef): string {
  return `${ref.platform}:${ref.channel}:${ref.messageId}`;
}

/** Cache key of slot `n` of the signals stored on a message no incident owns yet. */
export function pendingKey(ref: MessageRef, n: number): string {
  return `signals:pending:${refKey(ref)}:${String(n)}`;
}

function adoptedKey(ref: MessageRef): string {
  return `signals:adopted:${refKey(ref)}`;
}

/** Stores `signal` in the first free slot, for the playbook's counting window. False when all are taken. */
async function storePending(deps: SignalDeps, playbook: Playbook, ref: MessageRef, signal: SignalInput): Promise<boolean> {
  const ttlSec = Math.max(60, Math.ceil(parseDuration(playbook.weights.window) / 1000));
  const body = JSON.stringify(signal);
  for (let n = 0; n < PENDING_SLOTS; n++) {
    if (await deps.cache.setIfAbsent(pendingKey(ref, n), body, ttlSec)) return true;
  }
  return false;
}

const INTENTS: ReadonlySet<string> = new Set<string>(PLAYBOOK_INTENTS);
const SOURCES: ReadonlySet<string> = new Set<string>(['reaction', 'reaction-removed', 'message']);

/** A stored signal read back from the cache, or undefined when it is not one. */
function parsePending(raw: string): SignalInput | undefined {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const actor = o['actor'] as Record<string, unknown> | undefined;
  const target = o['target'] as Record<string, unknown> | undefined;
  const ok =
    typeof o['intent'] === 'string' &&
    INTENTS.has(o['intent']) &&
    typeof o['source'] === 'string' &&
    SOURCES.has(o['source']) &&
    (o['platform'] === 'slack' || o['platform'] === 'teams') &&
    typeof o['confidence'] === 'number' &&
    typeof o['raw'] === 'string' &&
    typeof o['timestamp'] === 'string' &&
    Number.isFinite(Date.parse(o['timestamp'])) &&
    typeof actor === 'object' &&
    actor !== null &&
    typeof actor['id'] === 'string' &&
    typeof actor['name'] === 'string' &&
    (actor['role'] === 'engineer' || actor['role'] === 'reporter' || actor['role'] === 'unknown') &&
    typeof target === 'object' &&
    target !== null &&
    typeof target['channel'] === 'string' &&
    typeof target['messageId'] === 'string' &&
    (o['environment'] === undefined || typeof o['environment'] === 'string') &&
    (o['deepLink'] === undefined || typeof o['deepLink'] === 'string') &&
    (o['githubLinked'] === undefined || typeof o['githubLinked'] === 'boolean');
  return ok ? (o as unknown as SignalInput) : undefined;
}

/**
 * The stored signals adoption applies, oldest first: per person and intent the latest one, dropped
 * when it is a removal (the reaction was taken back before anyone reported), and only adoptable intents.
 */
function latestPerPerson(signals: readonly SignalInput[]): SignalInput[] {
  const latest = new Map<string, SignalInput>();
  const ordered = [...signals].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  for (const s of ordered) latest.set(`${s.actor.id}\u0000${s.intent}`, s);
  return [...latest.values()]
    .filter((s) => s.source !== 'reaction-removed' && ADOPTABLE.has(s.intent))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}
