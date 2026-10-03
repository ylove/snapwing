// The orchestrator's step functions (main 14.1). Each runs one `Phase` from cursor.ts against an
// `EngineDeps`, appends what it learned with `expectedSeq` (with any outbox rows and artifacts in the
// same transaction), and says whether the job continues, parks, or stops. A step never assumes it is
// the first to get there: on `ExpectedSeqConflictError` the caller re-reads the log and decides again.

import { applyAnswer } from '../clarify/answer.ts';
import { DEFAULT_MAX_QUESTIONS, DEFAULT_SUPPRESS_REPORTERS } from '../clarify/gate.ts';
import { findGap, maybeAsk, type ClarifyEvidence } from '../clarify/index.ts';
import { fixedNote, readAnswer, ticketNote, userSideCheck, withEnvironment, type UserSideCheck } from '../clarify/user-side.ts';
import { collectWindow, DEFAULT_COLLECT_POLICY, widenPolicy, type Anchor, type CollectPolicy } from '../context/collect.ts';
import { narrow, scopePreview } from '../context/scope-preview.ts';
import { segment } from '../context/segment.ts';
import { readImages } from '../context/vision/index.ts';
import type { InteractiveCard } from '../contracts/adapters.ts';
import type { ArtifactRef, EventActor, EventPayloads, EventSource, EventType, NewEvent, UserSideCheckRecord, WaitingOn } from '../contracts/events.ts';
import type { CanonicalIncidentPayload, ChannelSource, ContextBundle, Resolution, TriageResolutionPlan } from '../contracts/incident.ts';
import type { Job } from '../contracts/jobs.ts';
import { isExpectedSeqConflict, type OutboxItem } from '../contracts/state.ts';
import { dedupe, rememberIncident } from '../dedupe/index.ts';
import type { JiraLogicalStatus } from '../jira/statuses.ts';
import { LABEL_NEEDS_CLARIFICATION, LABEL_PROMPT_FAILED, synthesizeIssue, type SynthesisContext, type SynthesizedIssue } from '../jira/synthesis.ts';
import type { MapPerson, WorkspaceMap } from '../map/types.ts';
import type { StatePort } from '../ports/state.ts';
import { resolve } from '../resolve/index.ts';
import { lastSeqPastBotRecords, RECORD_APPEND_TRIES } from '../signals/messages.ts';
import { atLeastPriority, escalationState, type EscalationState } from '../signals/score.ts';
import { findSurface } from '../resolve/lookup.ts';
import { JIRA_DONE, JIRA_IN_PROGRESS, LABEL_HUMAN_CLAIMED, jiraCommentBatchKey, jiraCreateBatchKey, jiraFieldBatchKey } from '../state/projections/outbox/jira.ts';
import { plan, toAdf } from '../triage/plan.ts';
import { parseDuration } from '../util/duration.ts';
import { ulid } from '../util/ulid.ts';
import type { ClaimHold } from './claims.ts';
import { approvedFix, answerAfter, pendingCard, userSideRound, type Cursor, type Phase, type Tap, type UserSideRound } from './cursor.ts';
import { currentPlaybook, DEFAULT_AGENT_NAME, DEFAULT_MAX_SCOPE_ROUNDS, DEFAULT_TAP_TIMEOUT, type EngineDeps, type StatusSubscription } from './deps.ts';

/** The logical Jira target that starts the fixer (main 14.1: "fires fixer webhook"); the projector resolves it (#268). */
export const IN_PROGRESS: JiraLogicalStatus = JIRA_IN_PROGRESS;

/** What a step tells the job loop: run the next phase, or return from the handler. */
export type StepResult = 'continue' | 'park' | 'stop';

export interface StepEnv {
  deps: EngineDeps;
  map: WorkspaceMap;
  job: Job;
  cursor: Cursor;
  payload: CanonicalIncidentPayload;
  /**
   * True while this delivery is a park timeout (`isTimedOut(job.resumed.result)`) whose default no
   * await step has applied yet. Shared across the loop's iterations.
   */
  delivery: { timedOut: boolean };
}

// Outbox payloads (B 7.1). The Jira projector (phase 3) validates and sends them.

/** `create-issue`: the synthesized create payload (main 9.1, B 7.2), custom fields by name. */
export interface CreateIssueRow {
  fields: SynthesizedIssue['fields'];
  customFields: SynthesizedIssue['customFields'];
  suggestedAssigneeEmail?: string;
  promptErrors?: string[];
  /** Image attachments to upload once the issue exists (the shape of the Jira projector's `ScreenshotRef`). */
  screenshots?: { url: string; filename?: string; contentType?: string }[];
}

/** `transition`: move an existing issue to a logical target (`jira/statuses.ts`), with an optional resolution name. */
export interface TransitionRow {
  issueKey: string;
  to: JiraLogicalStatus;
  resolution?: string;
}

/** `add-labels`: appended to the issue's labels. */
export interface AddLabelsRow {
  issueKey: string;
  labels: string[];
}

/** The resolution Not a bug closes a filed issue with (main 8.2). */
export const WONT_DO_RESOLUTION = "Won't Do";

/** `add-comment`: plain text; the projector renders ADF and merges by `batchKey` (B 7.1). */
export interface AddCommentRow {
  issueKey: string;
  text: string;
}

// Small helpers ---------------------------------------------------------------------------------

function eventSource(source: ChannelSource): EventSource {
  return source === 'slack' || source === 'teams' || source === 'cli' ? source : 'agent';
}

export function newEvent<T extends EventType>(
  env: Pick<StepEnv, 'deps' | 'cursor'>,
  type: T,
  payload: EventPayloads[T],
  extra: { actor?: EventActor; source?: EventSource; occurredAt?: string } = {},
): NewEvent<T> {
  const event = {
    workspaceId: env.deps.workspaceId,
    incidentId: env.cursor.incidentId,
    type,
    v: 1,
    source: extra.source ?? 'agent',
    ...(extra.actor === undefined ? {} : { actor: extra.actor }),
    occurredAt: extra.occurredAt ?? env.deps.clock().toISOString(),
    payload,
  };
  return event as unknown as NewEvent<T>;
}

function outboxRow(
  env: Pick<StepEnv, 'deps' | 'cursor'>,
  op: 'create-issue' | 'transition' | 'add-comment' | 'add-labels',
  payload: CreateIssueRow | TransitionRow | AddCommentRow | AddLabelsRow,
): OutboxItem {
  const now = env.deps.clock();
  const at = now.toISOString();
  return {
    ...(op === 'create-issue' ? { batchKey: jiraCreateBatchKey(env.cursor.incidentId) } : {}),
    id: ulid(now.getTime()),
    workspaceId: env.deps.workspaceId,
    target: 'jira',
    incidentId: env.cursor.incidentId,
    op,
    payload: { ...payload },
    attempts: 0,
    nextAttempt: at,
    createdAt: at,
  };
}

/**
 * Appends `events` after `cursor.lastSeq`. With `effects`, runs in one transaction: `effects` writes
 * artifacts and outbox rows on `tx` and returns events of its own, appended after `events`.
 * A conflict with nothing but records of what the bot posted (a card the step just posted, the status
 * message) appends after them: they are no decision's input (#287). Any other conflict throws.
 */
async function commit(
  env: StepEnv,
  events: readonly NewEvent[],
  effects?: (tx: StatePort) => Promise<NewEvent[]>,
): Promise<void> {
  const { state } = env.deps;
  const id = env.cursor.incidentId;
  for (let attempt = 1; ; attempt++) {
    try {
      const { seq } =
        effects === undefined
          ? await state.append(id, [...events], env.cursor.lastSeq)
          : await state.transaction(async (tx) => {
              const more = await effects(tx);
              return tx.append(id, [...events, ...more], env.cursor.lastSeq);
            });
      env.cursor.lastSeq = seq;
      return;
    } catch (err) {
      const past = isExpectedSeqConflict(err) && attempt < RECORD_APPEND_TRIES ? await lastSeqPastBotRecords(state, id, env.cursor.lastSeq) : undefined;
      if (past === undefined) throw err;
      env.cursor.lastSeq = past;
    }
  }
}

function agentName(env: StepEnv): string {
  return env.deps.options?.agentName ?? DEFAULT_AGENT_NAME;
}

function tapTimeoutMs(env: StepEnv): number {
  return parseDuration(env.deps.options?.tapTimeout ?? DEFAULT_TAP_TIMEOUT);
}

function hours(ms: number): string {
  const h = Math.round(ms / 3_600_000);
  return h === 1 ? '1 hour' : `${h} hours`;
}

function who(tap: Tap): string {
  return tap.actor?.id ?? 'someone';
}

/** The envelope of a decision event (ADR 0015): the tapper and the chat source, or the agent for a timeout. */
function decidedBy(env: Pick<StepEnv, 'payload'>, tap: Tap | undefined): { actor?: EventActor; source?: EventSource } {
  if (tap?.actor === undefined) return {};
  return { actor: tap.actor, source: eventSource(env.payload.source) };
}

function basePolicy(env: StepEnv): CollectPolicy {
  return env.deps.options?.collectPolicy ?? DEFAULT_COLLECT_POLICY;
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`engine: ${what} is missing from the log`);
  return value;
}

/** Takes the timeout default for this delivery, once. */
function takeTimeout(env: StepEnv): boolean {
  const timedOut = env.delivery.timedOut;
  env.delivery.timedOut = false;
  return timedOut;
}

// Payload, anchor, bundle -----------------------------------------------------------------------

/** The canonical payload as `captured` recorded it; the incident id is the payload's event id. */
export function payloadOf(cursor: Cursor): CanonicalIncidentPayload {
  const captured = must(cursor.captured, 'captured');
  const c = captured.payload;
  return {
    eventId: cursor.incidentId,
    idempotencyKey: c.idempotencyKey,
    source: c.source,
    reporter: c.reporter,
    anchorText: c.anchorText,
    context: {
      channelId: c.channelId,
      ...(c.threadId === undefined ? {} : { threadId: c.threadId }),
      ...(c.deepLink === undefined ? {} : { deepLink: c.deepLink }),
      rawPayloadSnapshot: c.rawPayloadSnapshot ?? {},
    },
    timestamp: captured.occurredAt,
  };
}

/** A channel with no history to read: the payload itself is the anchor. */
export function directAnchor(payload: CanonicalIncidentPayload): Anchor {
  return {
    channelId: payload.context.channelId,
    direct: true,
    message: {
      id: payload.eventId,
      authorId: payload.reporter.id,
      text: payload.anchorText,
      timestamp: payload.timestamp,
      mentions: [],
      reactions: [],
      attachments: [],
    },
  };
}

function anchorFor(env: Pick<StepEnv, 'deps'>, payload: CanonicalIncidentPayload): Promise<Anchor> {
  const source = env.deps.context?.get(payload.source);
  return source === undefined ? Promise.resolve(directAnchor(payload)) : source.anchor(payload);
}

/** The playbook's `recordings` as `readRecording` options: ISO duration to seconds; an unparseable one keeps the default. */
function recordingSettings(r: { maxDuration: string; sampleFps: number }): { maxDuration?: number; sampleFps: number } {
  try {
    return { maxDuration: parseDuration(r.maxDuration) / 1000, sampleFps: r.sampleFps };
  } catch {
    return { sampleFps: r.sampleFps };
  }
}

/** Collection (5.1, 5.2), the vision pass (5.2a), and segmentation with resolution signals (5.3, 5.4). */
async function gather(env: StepEnv, anchor: Anchor, mode: { policy: CollectPolicy } | 'narrow'): Promise<ContextBundle> {
  const { deps } = env;
  const reader = deps.context?.get(env.payload.source)?.reader;
  const policy = mode === 'narrow' ? basePolicy(env) : mode.policy;
  const raw: ContextBundle =
    reader === undefined
      ? {
          anchorId: anchor.message.id,
          included: [anchor.message],
          excluded: [],
          windowUsed: { oldest: anchor.message.timestamp, latest: anchor.message.timestamp, cap: policy.cap },
        }
      : mode === 'narrow'
        ? await narrow(anchor, reader, policy)
        : await collectWindow(anchor, reader, policy);
  const { loadImage, loadRecording, recordingTools } = deps.options ?? {};
  const recordings = (await currentPlaybook(deps)).recordings;
  const read = await readImages(raw, deps.model, {
    ...(loadImage === undefined ? {} : { loadImage }),
    ...(loadRecording === undefined ? {} : { loadRecording }),
    recordings: { ...recordingTools, ...recordingSettings(recordings) },
  });
  // A pile of one is the anchor alone: nothing to sort, and no later message can retract it.
  return read.included.length > 1 ? segment(read, anchor, deps.model) : read;
}

function isBundle(v: unknown): v is ContextBundle {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['anchorId'] === 'string' && Array.isArray(o['included']) && Array.isArray(o['excluded']);
}

async function loadBundle(env: StepEnv): Promise<ContextBundle> {
  const ref = must(env.cursor.assembled, 'context-assembled').payload.bundle;
  const artifact = await env.deps.state.getArtifact(ref.artifactId, ref.version);
  const body: unknown = JSON.parse(artifact.body);
  if (!isBundle(body)) throw new Error(`engine: artifact ${ref.artifactId} v${ref.version} is not a context bundle`);
  return body;
}

/** `context-assembled` for the first bundle, or `scope-changed` for a Widen or Narrow (ADR 0015). */
function bundleEvents(env: StepEnv, bundle: ContextBundle, ref: ArtifactRef, scope?: { choice: 'widen' | 'narrow'; tap: Tap }): NewEvent[] {
  const counts = { bundle: ref, includedCount: bundle.included.length, excludedCount: bundle.excluded.length };
  const head =
    scope === undefined
      ? newEvent(env, 'context-assembled', counts)
      : newEvent(env, 'scope-changed', { choice: scope.choice, ...counts }, decidedBy(env, scope.tap));
  const signal = bundle.resolutionSignal;
  return signal === undefined ? [head] : [head, newEvent(env, 'resolution-signal', { messageId: signal.messageId, text: signal.text })];
}

function putBundle(env: StepEnv, tx: StatePort, bundle: ContextBundle, id?: string): Promise<ArtifactRef> {
  return tx
    .putArtifact({
      ...(id === undefined ? {} : { id }),
      workspaceId: env.deps.workspaceId,
      incidentId: env.cursor.incidentId,
      kind: 'bundle',
      contentType: 'application/json',
      body: JSON.stringify(bundle),
      createdBy: agentName(env),
    })
    .then(({ id: artifactId, version }) => ({ artifactId, version }));
}

// awaitInteractive (B 5) --------------------------------------------------------------------------

/**
 * Records the wait, parks the job on `{ kind: 'tap', eventId }` with the interactive timeout, and
 * only then posts the card, so a tap can never arrive before the park (ADR 0012). The incident id is
 * the payload's event id, which the adapter puts on the card's buttons.
 */
async function awaitCard(env: StepEnv, card: InteractiveCard, waitFor: string | undefined, before: NewEvent[] = []): Promise<StepResult> {
  const waitingOn: WaitingOn = { kind: 'human', ...(waitFor === undefined ? {} : { who: waitFor }) };
  const events = env.cursor.waiting ? before : [...before, newEvent(env, 'waiting-changed', { waitingOn })];
  if (events.length > 0) await commit(env, events);
  const timeoutAt = new Date(env.deps.clock().getTime() + tapTimeoutMs(env));
  await env.deps.workflow.park(env.job.id, { kind: 'tap', eventId: env.cursor.incidentId }, timeoutAt);
  env.delivery.timedOut = false;
  await adapterFor(env)?.postInteractive(env.payload, card);
  return 'park';
}

function adapterFor(env: Pick<StepEnv, 'deps' | 'payload'>) {
  return env.deps.adapters.get(env.payload.source);
}

function ended(env: StepEnv): NewEvent[] {
  return env.cursor.waiting ? [newEvent(env, 'waiting-changed', {})] : [];
}

// Steps -------------------------------------------------------------------------------------------

/** First event of the incident (expectedSeq 0). The incident id is the payload's event id. */
export async function captureStep(env: Omit<StepEnv, 'payload'>, initial: CanonicalIncidentPayload | undefined): Promise<StepResult> {
  if (initial === undefined) throw new Error(`engine: incident ${env.cursor.incidentId} has no captured event and the job carries no payload`);
  const anchor = await anchorFor(env, initial);
  const p = initial;
  const captured = newEvent(
    env,
    'captured',
    {
      kind: 'incident',
      idempotencyKey: p.idempotencyKey,
      source: p.source,
      reporter: p.reporter,
      anchorText: p.anchorText,
      anchorId: anchor.message.id,
      channelId: p.context.channelId,
      ...(p.context.threadId === undefined ? {} : { threadId: p.context.threadId }),
      ...(p.context.deepLink === undefined ? {} : { deepLink: p.context.deepLink }),
      rawPayloadSnapshot: p.context.rawPayloadSnapshot,
    },
    { source: eventSource(p.source), actor: { id: p.reporter.id, role: p.reporter.role }, occurredAt: p.timestamp },
  );
  await env.deps.state.append(env.cursor.incidentId, [captured], 0);
  return 'continue';
}

/** main 5: collect, read images, segment. A resolution signal ends the incident as not filed. */
export async function assembleStep(env: StepEnv): Promise<StepResult> {
  const anchor = await anchorFor(env, env.payload);
  const bundle = await gather(env, anchor, { policy: basePolicy(env) });
  await commit(env, [], async (tx) => bundleEvents(env, bundle, await putBundle(env, tx, bundle)));
  return 'continue';
}

/**
 * main 5.5 scope preview. Widen and Narrow rebuild the bundle as a new version of the same artifact
 * and append `scope-changed` pointing at it (the reporter's choice, ADR 0015); the card is then shown
 * again. Looks right, a timeout, or a Widen past `maxScopeRounds` goes on to resolve.
 */
export async function scopeStep(env: StepEnv, phase: Extract<Phase, { kind: 'scope' }>): Promise<StepResult> {
  const assembled = must(env.cursor.assembled, 'context-assembled');
  const max = env.deps.options?.maxScopeRounds ?? DEFAULT_MAX_SCOPE_ROUNDS;
  const answer = phase.answer;
  if (answer !== undefined) {
    if (assembled.scopeHistory.length >= max) return resolveStep(env);
    const choice = answer.payload.choice === 'narrow' ? 'narrow' : 'widen';
    let policy = basePolicy(env);
    for (const h of assembled.scopeHistory) if (h === 'widen') policy = widenPolicy(policy);
    const anchor = await anchorFor(env, env.payload);
    const bundle = await gather(env, anchor, choice === 'narrow' ? 'narrow' : { policy: widenPolicy(policy) });
    await commit(env, [], async (tx) =>
      bundleEvents(env, bundle, await putBundle(env, tx, bundle, assembled.payload.bundle.artifactId), { choice, tap: answer }),
    );
    return 'continue';
  }
  if (takeTimeout(env)) return resolveStep(env);
  const bundle = await loadBundle(env);
  const names: Record<string, string> = {};
  for (const p of env.map.people) {
    if (p.slackId !== undefined) names[p.slackId] = p.handle;
    if (p.teamsId !== undefined) names[p.teamsId] = p.handle;
  }
  return awaitCard(env, { kind: 'scope-preview', summary: scopePreview(bundle, { names }).text }, env.payload.reporter.id);
}

/** main 4.4: the confidence stack. */
export async function resolveStep(env: StepEnv): Promise<StepResult> {
  const bundle = await loadBundle(env);
  const resolution = await resolve(env.payload, bundle, env.map, env.deps.model);
  await commit(env, [newEvent(env, 'resolved', resolution)]);
  return 'continue';
}

/** main 6: dedupe before create. Candidates leave the decision `pending-user` for the dedupe card. */
export async function dedupeStep(env: StepEnv): Promise<StepResult> {
  const bundle = await loadBundle(env);
  const resolution = must(env.cursor.resolved, 'resolved').resolution;
  const result = await dedupe(resolution, bundle, { jira: env.deps.jiraSearch, cache: env.deps.cache });
  await commit(env, [newEvent(env, 'dedupe-checked', result)]);
  return 'continue';
}

/**
 * The dedupe card. `link` joins the existing issue (terminal; a comment on that issue is an outbox
 * row); `create-anyway`, `not-related`, or a timeout goes on. Either way `dedupe-decided` records what
 * was decided and by whom (ADR 0015).
 */
export async function dedupeCardStep(env: StepEnv, phase: Extract<Phase, { kind: 'dedupe-card' }>): Promise<StepResult> {
  const checked = must(env.cursor.dedupe, 'dedupe-checked');
  const top = checked.result.candidates[0];
  const answer = phase.answer;
  const choice = answer?.payload.choice;
  if (answer !== undefined && choice === 'link' && top !== undefined) {
    return linkStep(env, top.issueKey, answer);
  }
  let decided: NewEvent;
  if (answer !== undefined && (choice === 'create-anyway' || choice === 'not-related')) {
    decided = newEvent(env, 'dedupe-decided', { decision: choice === 'create-anyway' ? 'create-anyway' : 'not-related' }, decidedBy(env, answer));
  } else if (answer !== undefined || top === undefined) {
    // Nothing to link: the agent goes on as Create anyway.
    decided = newEvent(env, 'dedupe-decided', { decision: 'create-anyway' });
  } else if (takeTimeout(env)) {
    decided = newEvent(env, 'dedupe-decided', { decision: 'create-anyway', timedOut: true });
  } else {
    const card: InteractiveCard = { kind: 'dedupe', issueKey: top.issueKey, summary: top.summary, ...(top.assignee === undefined ? {} : { assignee: top.assignee }) };
    return awaitCard(env, card, env.payload.reporter.id);
  }
  await commit(env, [decided, ...ended(env)]);
  return 'continue';
}

async function linkStep(env: StepEnv, issueKey: string, tap: Tap): Promise<StepResult> {
  const where = env.payload.context.deepLink ?? `${env.payload.source} channel ${env.payload.context.channelId}`;
  // Status first: a crash before the append repeats it, which beats never sending it.
  const text = `Already tracked as ${issueKey}; I added this report to it.`;
  await subscribeStatus(env, issueKey, text, text);
  await commit(
    env,
    [newEvent(env, 'dedupe-decided', { decision: 'link', issueKey }, decidedBy(env, tap)), newEvent(env, 'linked-to-existing', { issueKey })],
    async (tx) => {
      await tx.enqueueOutbox(outboxRow(env, 'add-comment', { issueKey, text: `Another report of this from ${env.payload.reporter.name}: ${where}` }));
      return [];
    },
  );
  return 'continue';
}

/**
 * main 7: the ask-back gate. A question that passes is recorded as `clarified` (asked, with what it
 * asks about and its options) and posted; one that fails the gate is not asked and the ticket gets
 * `needs-clarification`. A user-side check (A 5.2) that passes the gate comes first and is the
 * round's one question: it is recorded as `clarified` with `userSide`, so it counts against the budget.
 */
export async function clarifyStep(env: StepEnv): Promise<StepResult> {
  const bundle = await loadBundle(env);
  const resolution = must(env.cursor.resolved, 'resolved').resolution;
  // A 1.4: once the reaction ladder suppressed the ask-back, it is an incident, not a question.
  const escalated = (await reactionEscalation(env)).suppressAskBack;
  const evidence: ClarifyEvidence = { ...((await env.deps.evidence?.(env.payload, resolution)) ?? {}), ...(escalated ? { escalated } : {}) };
  const check = await userSideCheckFor(env, bundle, evidence);
  if (check?.question.gatePassed === true) {
    const asked = newEvent(env, 'clarified', {
      audience: 'reporter',
      question: check.question.text,
      ...(check.question.asks === undefined ? {} : { asks: check.question.asks }),
      ...(check.question.options === undefined ? {} : { options: check.question.options }),
      userSide: check.record,
      timedOut: false,
    });
    return awaitCard(env, { kind: 'clarify', question: check.question }, env.payload.reporter.id, [asked]);
  }
  const question = await maybeAsk(env.payload, bundle, resolution, env.map, env.deps.model, {
    ...evidence,
    questionsAsked: env.cursor.clarified.length,
  });
  if (question?.gatePassed !== true) return planStep(env, question !== undefined, bundle);
  const waitFor = question.audience === 'engineer' ? resolution.ownerId : env.payload.reporter.id;
  const asked = newEvent(env, 'clarified', {
    audience: question.audience,
    question: question.text,
    ...(question.asks === undefined ? {} : { asks: question.asks }),
    ...(question.options === undefined ? {} : { options: question.options }),
    timedOut: false,
  });
  return awaitCard(env, { kind: 'clarify', question }, waitFor, [asked]);
}

/** A 5.2: the user-side check for this bundle under the current playbook and the ask-back budget (main 7.2). */
async function userSideCheckFor(env: StepEnv, bundle: ContextBundle, evidence: ClarifyEvidence): Promise<UserSideCheck | undefined> {
  const policy = env.map.policies.askBack;
  return userSideCheck(bundle, await currentPlaybook(env.deps), {
    maxQuestionsPerIncident: policy?.maxQuestionsPerIncident ?? DEFAULT_MAX_QUESTIONS,
    suppressWhenReportersAtLeast: policy?.suppressWhenReportersAtLeast ?? DEFAULT_SUPPRESS_REPORTERS,
    questionsAsked: env.cursor.clarified.length,
    reportersInWindow: evidence.reportersInWindow ?? 1,
    ...(evidence.escalated === undefined ? {} : { escalated: evidence.escalated }),
  });
}

/** What the A 1.4 reaction ladder has done so far (signals/score.ts), read from the log. */
async function reactionEscalation(env: StepEnv): Promise<EscalationState> {
  return escalationState(await env.deps.state.read(env.cursor.incidentId));
}

/** A 1.4: priority only moves up automatically, so the plan never files below what reactions raised. */
function withEscalatedPriority<T extends { priority: TriageResolutionPlan['priority'] }>(plan: T, escalation: EscalationState): T {
  const priority = atLeastPriority(plan.priority, escalation.priority);
  return priority === plan.priority ? plan : { ...plan, priority };
}

/**
 * The answer to a user-side check (A 5.2). That fixed it ends the incident unfiled: `clarify-answered`,
 * then `user-side` with the indicator kind (no ticket, no Jira row, so the reporter's name reaches no
 * issue), and a friendly note in the thread, sent first as `linkStep` does. Still broken and I meant
 * <env> append `clarify-answered` and go on to the plan step, which files with the check recorded or
 * the environment set.
 */
async function userSideAnswerStep(env: StepEnv, questionSeq: number, check: UserSideCheckRecord, answer: Tap): Promise<StepResult> {
  const choice = answer.payload.choice;
  const answered = newEvent(env, 'clarify-answered', { questionSeq, answer: choice }, decidedBy(env, answer));
  if (readAnswer(check, choice).kind !== 'fixed') {
    await commit(env, [answered, ...ended(env)]);
    return 'continue';
  }
  const surfaceId = env.cursor.resolved?.resolution.surfaceId;
  await adapterFor(env)?.postStatus(env.payload, { issueKey: '', stage: 'clarified', text: fixedNote(check) });
  const userSide = newEvent(
    env,
    'user-side',
    { kind: check.kind, evidence: check.evidence, questionSeq, ...(surfaceId === undefined ? {} : { surfaceId }) },
    decidedBy(env, answer),
  );
  await commit(env, [answered, ...ended(env), userSide]);
  return 'continue';
}

/**
 * The clarify card (main 7, ADR 0015). An answer appends `clarify-answered`; when the question asked
 * about the surface or component and the answer is that entry's map label, a second `resolved`
 * (`resolvedBy: 'clarify'`) follows, so triage files to that surface. A timeout appends
 * `waiting-changed {}` alone: the round ends unanswered and the ticket gets `needs-clarification`.
 */
export async function clarifyCardStep(env: StepEnv, phase: Extract<Phase, { kind: 'clarify-card' }>): Promise<StepResult> {
  const last = must(env.cursor.clarified[env.cursor.clarified.length - 1], 'clarified');
  const resolution = must(env.cursor.resolved, 'resolved').resolution;
  const answer = phase.answer;
  const check = last.payload.userSide;
  if (answer !== undefined && check !== undefined) return userSideAnswerStep(env, last.seq, check, answer);
  if (answer !== undefined) {
    const text = answer.payload.choice;
    const applied = applyAnswer(last.payload.asks, text, resolution, env.map);
    const answered = newEvent(
      env,
      'clarify-answered',
      { questionSeq: last.seq, answer: text, ...(applied === undefined ? {} : { appliesTo: applied.appliesTo }) },
      decidedBy(env, answer),
    );
    const resolved = applied === undefined ? [] : [newEvent(env, 'resolved', applied.resolution)];
    await commit(env, [answered, ...resolved, ...ended(env)]);
    return 'continue';
  }
  if (takeTimeout(env)) {
    // Appended even when no wait is recorded: this event is what closes the round.
    await commit(env, [newEvent(env, 'waiting-changed', {})]);
    return 'continue';
  }
  // A repost after a crash, with the recorded options.
  const { audience, question, asks, options } = last.payload;
  const waitFor = audience === 'engineer' ? resolution.ownerId : env.payload.reporter.id;
  const card: InteractiveCard = {
    kind: 'clarify',
    question: {
      audience,
      text: question,
      ...(options === undefined ? {} : { options }),
      ...(asks === undefined ? {} : { asks }),
      gatePassed: true,
      gateFailures: [],
    },
  };
  return awaitCard(env, card, waitFor);
}

function synthesisContext(env: StepEnv, resolution: Resolution, needsClarification: boolean): SynthesisContext {
  const surface = resolution.surfaceId === undefined ? undefined : findSurface(env.map, resolution.surfaceId);
  return { payload: env.payload, resolution, ...(surface === undefined ? {} : { surface }), needsClarification };
}

/**
 * The bundle's image attachments the issue carries, minus any whose vision reading is sensitive
 * (the filter `synthesizeIssue` applies to evidence). `filename` is the name the implementation
 * request's `attachment:<KEY>/<name>` ref uses.
 */
function screenshotsOf(bundle: ContextBundle): NonNullable<CreateIssueRow['screenshots']> {
  return bundle.included
    .flatMap((m) => m.attachments)
    .filter((a) => a.kind === 'image' && a.reading?.sensitive !== true)
    .map((a) => ({
      url: a.url,
      filename: a.url.split('/').pop()?.split('?')[0] ?? 'screenshot',
      ...(a.mimeType === undefined ? {} : { contentType: a.mimeType }),
    }));
}

function createIssueRow(issue: SynthesizedIssue, bundle: ContextBundle): CreateIssueRow {
  const screenshots = screenshotsOf(bundle);
  return {
    fields: issue.fields,
    customFields: issue.customFields,
    ...(issue.suggestedAssigneeEmail === undefined ? {} : { suggestedAssigneeEmail: issue.suggestedAssigneeEmail }),
    ...(issue.promptErrors.length === 0 ? {} : { promptErrors: issue.promptErrors }),
    ...(screenshots.length === 0 ? {} : { screenshots }),
  };
}

/**
 * Where an incident with no Jira project files (ADR 0015): the install's `fallbackJiraProject`, the
 * project of the map's `fallbackSurface`, the one project every map surface shares, or the first
 * surface's project. Undefined when the resolution
 * already names a project or a known surface.
 */
export function fallbackProject(env: Pick<StepEnv, 'deps' | 'map'>, resolution: Resolution): string | undefined {
  if (resolution.jiraProject !== undefined) return undefined;
  if (resolution.surfaceId !== undefined && findSurface(env.map, resolution.surfaceId) !== undefined) return undefined;
  const configured = env.deps.options?.fallbackJiraProject;
  if (configured !== undefined && configured !== '') return configured;
  const mapped = env.map.fallbackSurface === undefined ? undefined : findSurface(env.map, env.map.fallbackSurface);
  if (mapped !== undefined) return mapped.jira.project;
  const projects = [...new Set(env.map.surfaces.map((s) => s.jira.project))];
  return projects.length === 1 ? projects[0] : env.map.surfaces[0]?.jira.project;
}

function unroutedNote(projectKey: string): string {
  return `Snapwing could not tell which product this report is about, so it filed it in ${projectKey} for someone to route. It is ticket only until then.`;
}

/** `descriptionAdf` with `text` as its first paragraph. */
function withNote(adf: Record<string, unknown>, text: string): Record<string, unknown> {
  const content = Array.isArray(adf['content']) ? (adf['content'] as unknown[]) : [];
  const note = toAdf(text)['content'] as unknown[];
  return { ...adf, type: 'doc', version: 1, content: [...note, ...content] };
}

/** `descriptionAdf` with a first paragraph saying why the ticket landed in the fallback project. */
function withUnroutedNote(adf: Record<string, unknown>, projectKey: string): Record<string, unknown> {
  return withNote(adf, unroutedNote(projectKey));
}

/** The bundle as filed: after `I meant <env>` on a user-side check (A 5.2), its readings say that environment. */
function filedBundle(bundle: ContextBundle, userSide: UserSideRound | undefined): ContextBundle {
  if (userSide?.answer === undefined) return bundle;
  const answer = readAnswer(userSide.check, userSide.answer);
  return answer.kind === 'meant' ? withEnvironment(bundle, answer.environment) : bundle;
}

/**
 * main 8 and 9: triage plan, autonomy level (from policy, inside `plan`), and ticket synthesis. The
 * full plan and the implementation request are stored as artifacts (ADR 0015). Levels 0, 2, 3 enqueue
 * `create-issue` with `planned`; level 1 shows the fix preview first. A `noop` plan ends the incident
 * as not a bug. An incident with no surface files to the fallback project at level 0 with
 * `needs-clarification` (#115), so triage never fails for want of a project.
 */
export async function planStep(env: StepEnv, needsClarification: boolean, known?: ContextBundle, userSide?: UserSideRound): Promise<StepResult> {
  const bundle = filedBundle(known ?? (await loadBundle(env)), userSide);
  const resolution = must(env.cursor.resolved, 'resolved').resolution;
  const checked = must(env.cursor.dedupe, 'dedupe-checked').result;
  const fallback = fallbackProject(env, resolution);
  const routed: Resolution = fallback === undefined ? resolution : { ...resolution, jiraProject: fallback };
  const drafted = await plan(env.payload, bundle, routed, checked, env.map, env.deps.model, env.deps.repoReader?.(resolution));
  if (drafted.action === 'noop') {
    await commit(env, [newEvent(env, 'not-a-bug', { reason: 'triage found nothing to file' })]);
    return 'continue';
  }
  // The dedupe card already decided: candidates reach triage only after Create anyway (or its
  // timeout), so a `link_existing` draft is filed as a new issue rather than overruling that choice.
  const { linkTo: _linkTo, ...unlinked } = drafted;
  const linked: TriageResolutionPlan = drafted.action === 'link_existing' ? { ...unlinked, action: 'create_issue' } : drafted;
  // A 5.2: the user-side check is recorded on the ticket, so engineers do not repeat it. It took the
  // round's one question, so a gap it left open still gets `needs-clarification`.
  const decided: TriageResolutionPlan =
    userSide === undefined
      ? linked
      : { ...linked, descriptionAdf: withNote(linked.descriptionAdf, ticketNote(userSide.check, userSide.answer === undefined ? undefined : readAnswer(userSide.check, userSide.answer))) };
  const gapLeft = userSide !== undefined && findGap(resolution, env.map) !== undefined;
  const clarify = needsClarification || gapLeft || fallback !== undefined;
  const labeled: TriageResolutionPlan = clarify ? { ...decided, labels: [...new Set([...decided.labels, LABEL_NEEDS_CLARIFICATION])] } : decided;
  // Unrouted: no repo for a fixer, so ticket only, and the description says why it is here.
  const routedPlan: TriageResolutionPlan =
    fallback === undefined ? labeled : { ...labeled, autonomyLevel: 0, descriptionAdf: withUnroutedNote(labeled.descriptionAdf, labeled.projectKey) };
  const triaged = withEscalatedPriority(routedPlan, await reactionEscalation(env));
  const level = triaged.autonomyLevel;
  const issue = await synthesizeIssue(triaged, bundle, level, synthesisContext(env, resolution, clarify));
  const prompt = issue.customFields['Implementation Prompt'];
  // A 2.1: an engineer already on it. Level 1 files ticket only through the fix-preview phase (no card).
  const held = env.cursor.hold !== undefined;
  await commit(env, [], async (tx) => {
    const artifact = (kind: 'plan' | 'implementation-request', body: string) =>
      tx
        .putArtifact({
          workspaceId: env.deps.workspaceId,
          incidentId: env.cursor.incidentId,
          kind,
          contentType: kind === 'plan' ? 'application/json' : 'application/xml',
          body,
          createdBy: agentName(env),
        })
        .then(({ id, version }): ArtifactRef => ({ artifactId: id, version }));
    const planRef = await artifact('plan', JSON.stringify(triaged));
    const ref = prompt === '' ? undefined : await artifact('implementation-request', prompt);
    if (level !== 1) await tx.enqueueOutbox(outboxRow(env, 'create-issue', createIssueRow(withClaim(env, issue), bundle)));
    return [
      newEvent(env, 'planned', {
        action: triaged.action,
        ...(triaged.linkTo === undefined ? {} : { linkTo: triaged.linkTo }),
        projectKey: triaged.projectKey,
        issueType: triaged.issueType,
        summary: triaged.summary,
        priority: triaged.priority,
        labels: triaged.labels,
        ...(triaged.componentId === undefined ? {} : { componentId: triaged.componentId }),
        autonomyLevel: level,
        ...(ref === undefined ? {} : { implementationRequest: ref }),
        plan: planRef,
        ...(fallback === undefined ? {} : { degraded: 'unresolved-surface' as const }),
      }),
    ];
  });
  if (level !== 1 || held) return 'continue';
  env.cursor.waiting = false; // `planned` changed the status, which ends any wait
  return awaitCard(env, { kind: 'fix-preview', plan: triaged }, resolution.ownerId);
}

const PLAN_ACTIONS: readonly string[] = ['create_issue', 'link_existing', 'noop'];

function isPlan(v: unknown): v is TriageResolutionPlan {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    PLAN_ACTIONS.includes(String(o['action'])) &&
    typeof o['projectKey'] === 'string' &&
    typeof o['issueType'] === 'string' &&
    typeof o['summary'] === 'string' &&
    typeof o['descriptionAdf'] === 'object' &&
    o['descriptionAdf'] !== null &&
    typeof o['priority'] === 'string' &&
    Array.isArray(o['labels']) &&
    typeof o['autonomyLevel'] === 'number'
  );
}

/**
 * The plan triage made, read back from the `plan` artifact `planned` references (#114), with the
 * level in force now (`level-changed` may have moved it). A log from before #114 has no artifact; its
 * plan is rebuilt from `planned`, without the model's write-up and the suggested assignee.
 */
async function plannedPlan(env: StepEnv): Promise<TriageResolutionPlan> {
  const p = must(env.cursor.planned, 'planned').payload;
  const level = env.cursor.level ?? p.autonomyLevel;
  if (p.plan !== undefined) {
    const body: unknown = JSON.parse((await env.deps.state.getArtifact(p.plan.artifactId, p.plan.version)).body);
    if (!isPlan(body)) throw new Error(`engine: artifact ${p.plan.artifactId} v${p.plan.version} is not a triage plan`);
    return { ...body, autonomyLevel: level };
  }
  return {
    action: p.action,
    ...(p.linkTo === undefined ? {} : { linkTo: p.linkTo }),
    projectKey: p.projectKey,
    issueType: p.issueType,
    summary: p.summary,
    descriptionAdf: toAdf(''),
    priority: p.priority,
    labels: p.labels,
    ...(p.componentId === undefined ? {} : { componentId: p.componentId }),
    autonomyLevel: level,
  };
}

/** The ticket a level 1 incident files after its fix preview: the same one `planStep` would have built. */
async function plannedIssue(env: StepEnv): Promise<SynthesizedIssue> {
  const planned = must(env.cursor.planned, 'planned').payload;
  const resolution = must(env.cursor.resolved, 'resolved').resolution;
  const triaged = await plannedPlan(env);
  const issue = await synthesizeIssue(triaged, filedBundle(await loadBundle(env), userSideRound(env.cursor)), triaged.autonomyLevel, synthesisContext(env, resolution, triaged.labels.includes(LABEL_NEEDS_CLARIFICATION)));
  // The implementation request validated at plan time is the one the fixer gets.
  const stored = planned.implementationRequest;
  const prompt = stored === undefined ? '' : (await env.deps.state.getArtifact(stored.artifactId, stored.version)).body;
  const labels = issue.fields.labels.filter((l) => l !== LABEL_PROMPT_FAILED);
  return {
    ...issue,
    fields: { ...issue.fields, labels: prompt === '' ? [...labels, LABEL_PROMPT_FAILED] : labels },
    customFields: { ...issue.customFields, 'Implementation Prompt': prompt },
    promptErrors: prompt === '' ? ['the implementation request did not validate at plan time'] : [],
  };
}

/**
 * Level 1 fix preview (main 14.1). Dismiss ends the incident as not a bug. Fix it and Ticket only
 * file the ticket; a timeout files it as ticket only (B 5 default). The wait's end is recorded with
 * the `create-issue` row; whether the fixer starts is read from the tap after `filed`. An engineer's
 * claim (A 2.1, `held`) files it ticket only at once, with no card; the claim card follows `filed`.
 */
export async function fixPreviewStep(env: StepEnv, phase: Extract<Phase, { kind: 'fix-preview' }>): Promise<StepResult> {
  const answer = phase.answer;
  if (answer === undefined && phase.held !== true && !takeTimeout(env)) {
    const resolution = must(env.cursor.resolved, 'resolved').resolution;
    return awaitCard(env, { kind: 'fix-preview', plan: await plannedPlan(env) }, resolution.ownerId);
  }
  if (answer?.payload.choice === 'dismiss') {
    await commit(env, [newEvent(env, 'not-a-bug', { reason: `dismissed at the fix preview by ${who(answer)}` })]);
    return 'continue';
  }
  const planned = await plannedIssue(env);
  // Reactions may have raised the priority while the preview waited (A 1.4).
  const { priority } = withEscalatedPriority({ priority: planned.fields.priority.name }, await reactionEscalation(env));
  const issue = withClaim(env, { ...planned, fields: { ...planned.fields, priority: { name: priority } } });
  const bundle = await loadBundle(env);
  await commit(env, [newEvent(env, 'waiting-changed', {})], async (tx) => {
    await tx.enqueueOutbox(outboxRow(env, 'create-issue', createIssueRow(issue, bundle)));
    return [];
  });
  return 'continue';
}

function filedText(issueKey: string, owner: string | undefined, note?: string): string {
  const base = `Filed as ${issueKey}${owner === undefined ? '' : `, assigned to @${owner}`}.`;
  return note === undefined ? base : `${base} ${note}`;
}

/**
 * Status loopback through `deps.status`, whose events and rows the caller writes with its own; or a
 * plain `filed` status through the adapter without one.
 */
async function subscribeStatus(env: StepEnv, issueKey: string, text: string, note?: string): Promise<StatusSubscription> {
  if (env.deps.status !== undefined) return env.deps.status.subscribe(env.payload, issueKey, note);
  await adapterFor(env)?.postStatus(env.payload, { issueKey, stage: 'filed', text });
  return { events: [], outbox: [] };
}

/**
 * After the outbox worker appends `filed` (phase 3; tests append it) and continues the job: level 2
 * and 3, and level 1 after Fix it, move the issue to In Progress (an outbox row; the fixer webhook
 * fires on it). Level 2 and 3 post the informational fix preview with Stop. Every level subscribes
 * the reporter to status and records who the incident now waits on, which marks this step done. A
 * reporter's claim before this step becomes a comment on the ticket here. An engineer's claim
 * (A 2.1) replaces the In Progress transition and the fix preview with the claim card.
 */
export async function afterFiledStep(env: StepEnv): Promise<StepResult> {
  const { cursor } = env;
  const issueKey = must(cursor.filed, 'filed').jiraKey;
  const planned = must(cursor.planned, 'planned');
  const resolution = must(cursor.resolved, 'resolved').resolution;
  const level = cursor.level ?? planned.payload.autonomyLevel;
  // A Stop between `filed` and this step leaves the issue in Backlog: no In Progress transition (so
  // no fixer) and no fix preview card (#206).
  const stopped = cursor.stoppedAfterFiled !== undefined;
  await rememberIncident(env.deps.cache, resolution, { issueKey, summary: planned.payload.summary });
  const comments = reporterClaimRows(env, issueKey, () => true);

  const hold = cursor.hold;
  if (hold !== undefined && !stopped) {
    const claimer = personLabel(env, hold.claimerId, hold.actor);
    const note = `${claimer} is on it, so this is filed as ticket only.`;
    const subscription = await subscribeStatus(env, issueKey, filedText(issueKey, claimer.slice(1), note), note);
    return postClaimCard(env, hold, issueKey, subscription.events, [...subscription.outbox, ...comments]);
  }

  const fixer = !stopped && (level >= 2 || (level === 1 && approvedFix(cursor)));
  const timedOut = level === 1 && answerAfter(cursor, 'fix-preview', planned.seq) === undefined;
  if (level >= 2 && !stopped) await adapterFor(env)?.postInteractive(env.payload, { kind: 'fix-preview', plan: await plannedPlan(env) });
  const note =
    planned.payload.degraded === 'unresolved-surface'
      ? `I could not tell which product this is about, so it is in ${planned.payload.projectKey} for someone to route.`
      : timedOut
        ? `Nobody tapped Fix it within ${hours(tapTimeoutMs(env))}, so this is filed as ticket only.`
        : undefined;
  const owner = resolution.ownerId;
  const subscription = await subscribeStatus(env, issueKey, filedText(issueKey, owner, note), note);

  const waitingOn: WaitingOn | undefined = fixer ? undefined : { kind: 'human', ...(owner === undefined ? {} : { who: owner }) };
  await commit(env, [...subscription.events, newEvent(env, 'waiting-changed', waitingOn === undefined ? {} : { waitingOn })], async (tx) => {
    for (const row of [...subscription.outbox, ...comments]) await tx.enqueueOutbox(row);
    if (fixer) await tx.enqueueOutbox(inProgressRow(env, issueKey));
    return [];
  });
  return 'continue';
}

/** The In Progress transition that starts the fixer, keyed as a write of the status field so a human transition before it is sent drops it (B 7.3). */
function inProgressRow(env: StepEnv, issueKey: string): OutboxItem {
  return { ...outboxRow(env, 'transition', { issueKey, to: IN_PROGRESS }), batchKey: jiraFieldBatchKey(env.cursor.incidentId, 'status') };
}

// Claims (A 2.1) -----------------------------------------------------------------------------------

function personOf(env: Pick<StepEnv, 'map'>, chatUserId: string): MapPerson | undefined {
  return env.map.people.find((p) => p.slackId === chatUserId || p.teamsId === chatUserId);
}

/** `@handle` from the map, else `@` and the name the event carries, else `@` and the chat user id. */
function personLabel(env: Pick<StepEnv, 'map'>, chatUserId: string, actor?: EventActor): string {
  const name = personOf(env, chatUserId)?.handle ?? (actor?.id === chatUserId ? actor.name?.trim() : undefined);
  return `@${name === undefined || name === '' ? chatUserId : name}`;
}

/**
 * The create payload while an engineer holds the incident (A 2.1): labeled `human-claimed`, and the
 * suggested assignee is the claimer (by the map's email; none when the map has no email for them).
 */
function withClaim(env: StepEnv, issue: SynthesizedIssue): SynthesizedIssue {
  const hold = env.cursor.hold;
  if (hold === undefined) return issue;
  const { suggestedAssigneeEmail: _owner, ...rest } = issue;
  const email = personOf(env, hold.claimerId)?.email;
  return {
    ...rest,
    fields: { ...issue.fields, labels: [...new Set([...issue.fields.labels, LABEL_HUMAN_CLAIMED])] },
    ...(email === undefined || email === '' ? {} : { suggestedAssigneeEmail: email }),
  };
}

/** A comment on the incident's own issue, batched with the lifecycle comments (B 7.1). */
function commentRow(env: Pick<StepEnv, 'deps' | 'cursor'>, issueKey: string, text: string): OutboxItem {
  return { ...outboxRow(env, 'add-comment', { issueKey, text }), batchKey: jiraCommentBatchKey(env.cursor.incidentId) };
}

/** A 2.1: a reporter's claim is a comment on the ticket ("@pat is looking into it.") and holds nothing. */
function reporterClaimRows(env: Pick<StepEnv, 'deps' | 'cursor' | 'map'>, issueKey: string, which: (seq: number) => boolean): OutboxItem[] {
  return env.cursor.reporterClaims
    .filter((c) => which(c.seq))
    .map((c) => commentRow(env, issueKey, `${personLabel(env, c.claimerId, c.actor)} is looking into it.`));
}

/** The read-only scout's diagnosis (main 8.1) as a ticket comment, for the human who took the fix (A 2.1). */
function diagnosisText(diagnosis: NonNullable<TriageResolutionPlan['diagnosis']>, claimer: string): string {
  const head = `The agent's read-only scout looked at the code while ${claimer} is on this. Diagnosis, ${diagnosis.confidence} confidence:`;
  if (diagnosis.files.length === 0) return `${head} no likely files found.`;
  return [head, ...diagnosis.files.map((f) => `- ${f.path}: ${f.note}`)].join('\n');
}

function claimCard(issueKey: string, hold: ClaimHold): InteractiveCard {
  return { kind: 'claimed', issueKey, claimerUserId: hold.claimerId };
}

/**
 * Shows the claim card for `hold` (A 2.1): labels the issue `human-claimed` when the claim came before
 * `filed` (the lifecycle rows label a claim after it), comments the scout's diagnosis, records the
 * wait on the claimer (which marks the card posted), parks, and posts the card.
 */
async function postClaimCard(env: StepEnv, hold: ClaimHold, issueKey: string, events: NewEvent[], rows: OutboxItem[]): Promise<StepResult> {
  const filed = must(env.cursor.filed, 'filed');
  const diagnosis = (await plannedPlan(env)).diagnosis;
  const extra: OutboxItem[] = [
    ...(hold.seq < filed.seq ? [outboxRow(env, 'add-labels', { issueKey, labels: [LABEL_HUMAN_CLAIMED] })] : []),
    ...(diagnosis === undefined ? [] : [commentRow(env, issueKey, diagnosisText(diagnosis, personLabel(env, hold.claimerId, hold.actor)))]),
  ];
  const waitingOn: WaitingOn = { kind: 'human', who: hold.claimerId };
  await commit(env, [...events, newEvent(env, 'waiting-changed', { waitingOn })], async (tx) => {
    for (const row of [...rows, ...extra]) await tx.enqueueOutbox(row);
    return [];
  });
  return parkOn(env, claimCard(issueKey, hold), true);
}

/** Parks on the tap wait with the interactive timeout, then posts `card` when `post` (the order `awaitCard` keeps). */
async function parkOn(env: StepEnv, card: InteractiveCard, post: boolean): Promise<StepResult> {
  const timeoutAt = new Date(env.deps.clock().getTime() + tapTimeoutMs(env));
  await env.deps.workflow.park(env.job.id, { kind: 'tap', eventId: env.cursor.incidentId }, timeoutAt);
  env.delivery.timedOut = false;
  if (post) await adapterFor(env)?.postInteractive(env.payload, card);
  return 'park';
}

/**
 * The claim card (A 2.1). `Let the agent take it` appends `let-agent-take` for the claimer (the
 * tapper is the actor; `handleTap` lets only an engineer choose it) and the configured level resumes
 * in the next phase. `Not a bug` appends `not-a-bug` and closes the filed issue as Won't Do. The card
 * has no default: a timeout parks again without reposting, and the claim lasts until it is handed
 * back or released (A 2.4).
 */
export async function claimCardStep(env: StepEnv, phase: Extract<Phase, { kind: 'claim-card' }>): Promise<StepResult> {
  const { hold, posted, answer } = phase;
  const issueKey = must(env.cursor.filed, 'filed').jiraKey;
  if (posted === undefined) return postClaimCard(env, hold, issueKey, [], []);
  if (answer === undefined) return parkOn(env, claimCard(issueKey, hold), !takeTimeout(env));
  if (answer.payload.choice === 'dismiss') {
    const notABug = newEvent(env, 'not-a-bug', { reason: `dismissed at the claim card by ${who(answer)}` }, decidedBy(env, answer));
    await commit(env, [notABug], async (tx) => {
      const close: TransitionRow = { issueKey, to: JIRA_DONE, resolution: WONT_DO_RESOLUTION };
      await tx.enqueueOutbox({ ...outboxRow(env, 'transition', close), batchKey: jiraFieldBatchKey(env.cursor.incidentId, 'status') });
      return [];
    });
    return 'continue';
  }
  await commit(env, [newEvent(env, 'let-agent-take', { claimerId: hold.claimerId }, decidedBy(env, answer))]);
  return 'continue';
}

/**
 * A hold ended after the after-filed step (`let-agent-take`, or `released` when the claim expired or
 * was let go): the configured level resumes. Levels 2 and 3 move the issue to In Progress and post
 * the informational fix preview; level 1 does the same when Let the agent take it ended the hold
 * (an engineer's tap, which is the Fix it approval) or Fix it was tapped before the claim; otherwise
 * the incident waits on the owner. A Stop since filing starts nothing. `deps.startFixer` starts the
 * fixer too, since the issue may already be In Progress (a claim after the transition was sent), and
 * a transition to the status it is in fires no webhook; a second start is refused by `fixer.run`.
 */
export async function claimEndedStep(env: StepEnv, phase: Extract<Phase, { kind: 'claim-ended' }>): Promise<StepResult> {
  const { cursor } = env;
  const issueKey = must(cursor.filed, 'filed').jiraKey;
  const planned = must(cursor.planned, 'planned');
  const owner = must(cursor.resolved, 'resolved').resolution.ownerId;
  const level = cursor.level ?? planned.payload.autonomyLevel;
  const stopped = cursor.stoppedAfterFiled !== undefined;
  const fixer = !stopped && (level >= 2 || (level === 1 && (phase.ended.by === 'let-agent-take' || approvedFix(cursor))));
  if (level >= 2 && fixer) await adapterFor(env)?.postInteractive(env.payload, { kind: 'fix-preview', plan: await plannedPlan(env) });
  const waitingOn: WaitingOn | undefined = fixer ? undefined : { kind: 'human', ...(owner === undefined ? {} : { who: owner }) };
  await commit(env, [newEvent(env, 'waiting-changed', waitingOn === undefined ? {} : { waitingOn })], async (tx) => {
    if (fixer) await tx.enqueueOutbox(inProgressRow(env, issueKey));
    return [];
  });
  if (fixer) await env.deps.startFixer?.(cursor.incidentId);
  return 'continue';
}

/**
 * A reporter's claim (seq `seq`) that arrived after the after-filed step: its comment on the ticket
 * (A 2.1). Claims before that step are commented by it. Resolves false when there was nothing to write.
 */
export async function reporterClaimComment(env: Pick<StepEnv, 'deps' | 'map' | 'cursor'>, seq: number): Promise<boolean> {
  const filed = env.cursor.filed;
  const afterFiled = filed === undefined ? undefined : env.cursor.waitChanges.find((s) => s > filed.seq);
  if (filed === undefined || afterFiled === undefined || seq < afterFiled) return false;
  const rows = reporterClaimRows(env, filed.jiraKey, (s) => s === seq);
  for (const row of rows) await env.deps.state.enqueueOutbox(row);
  return rows.length > 0;
}

/**
 * Runs one phase. `capture` is run by the caller, which holds the job's initial payload. A timeout
 * belongs to the card that was waiting: when the log already holds an answer (a tap that raced the
 * timeout) or the phase awaits nothing, the timeout default is dropped so it cannot answer a later card.
 */
export function runPhase(env: StepEnv, phase: Exclude<Phase, { kind: 'capture' | 'done' | 'await-filed' }>): Promise<StepResult> {
  if (pendingCard(phase) === undefined) env.delivery.timedOut = false;
  switch (phase.kind) {
    case 'assemble':
      return assembleStep(env);
    case 'scope':
      return scopeStep(env, phase);
    case 'resolve':
      return resolveStep(env);
    case 'dedupe':
      return dedupeStep(env);
    case 'dedupe-card':
      return dedupeCardStep(env, phase);
    case 'clarify':
      return clarifyStep(env);
    case 'clarify-card':
      return clarifyCardStep(env, phase);
    case 'plan':
      return planStep(env, phase.needsClarification, undefined, phase.userSide);
    case 'fix-preview':
      return fixPreviewStep(env, phase);
    case 'after-filed':
      return afterFiledStep(env);
    case 'claim-card':
      return claimCardStep(env, phase);
    case 'claim-ended':
      return claimEndedStep(env, phase);
  }
}
