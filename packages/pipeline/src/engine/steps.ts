// The orchestrator's step functions (main 14.1). Each runs one `Phase` from cursor.ts against an
// `EngineDeps`, appends what it learned with `expectedSeq` (with any outbox rows and artifacts in the
// same transaction), and says whether the job continues, parks, or stops. A step never assumes it is
// the first to get there: on `ExpectedSeqConflictError` the caller re-reads the log and decides again.

import { maybeAsk } from '../clarify/index.ts';
import { collectWindow, DEFAULT_COLLECT_POLICY, widenPolicy, type Anchor, type CollectPolicy } from '../context/collect.ts';
import { narrow, scopePreview } from '../context/scope-preview.ts';
import { segment } from '../context/segment.ts';
import { readImages } from '../context/vision/index.ts';
import type { InteractiveCard } from '../contracts/adapters.ts';
import type { ArtifactRef, EventActor, EventPayloads, EventSource, EventType, NewEvent, WaitingOn } from '../contracts/events.ts';
import type { CanonicalIncidentPayload, ChannelSource, ContextBundle, Resolution, TriageResolutionPlan } from '../contracts/incident.ts';
import type { Job } from '../contracts/jobs.ts';
import type { OutboxItem } from '../contracts/state.ts';
import { dedupe, rememberIncident } from '../dedupe/index.ts';
import { LABEL_NEEDS_CLARIFICATION, LABEL_PROMPT_FAILED, synthesizeIssue, type SynthesisContext, type SynthesizedIssue } from '../jira/synthesis.ts';
import type { WorkspaceMap } from '../map/types.ts';
import type { StatePort } from '../ports/state.ts';
import { resolve } from '../resolve/index.ts';
import { findSurface } from '../resolve/lookup.ts';
import { plan, toAdf } from '../triage/plan.ts';
import { parseDuration } from '../util/duration.ts';
import { ulid } from '../util/ulid.ts';
import { approvedFix, answerAfter, pendingCard, type Cursor, type Phase, type Tap } from './cursor.ts';
import { DEFAULT_AGENT_NAME, DEFAULT_MAX_SCOPE_ROUNDS, DEFAULT_TAP_TIMEOUT, type EngineDeps } from './deps.ts';

/** The Jira transition that starts the fixer (main 14.1: "fires fixer webhook"). */
export const IN_PROGRESS = 'In Progress';

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
}

/** `transition`: move an existing issue. */
export interface TransitionRow {
  issueKey: string;
  to: string;
}

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

function outboxRow(env: StepEnv, op: 'create-issue' | 'transition' | 'add-comment', payload: CreateIssueRow | TransitionRow | AddCommentRow): OutboxItem {
  const now = env.deps.clock();
  const at = now.toISOString();
  return {
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
 */
async function commit(
  env: StepEnv,
  events: readonly NewEvent[],
  effects?: (tx: StatePort) => Promise<NewEvent[]>,
): Promise<void> {
  const { state } = env.deps;
  const id = env.cursor.incidentId;
  const { seq } =
    effects === undefined
      ? await state.append(id, [...events], env.cursor.lastSeq)
      : await state.transaction(async (tx) => {
          const more = await effects(tx);
          return tx.append(id, [...events, ...more], env.cursor.lastSeq);
        });
  env.cursor.lastSeq = seq;
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
  const loadImage = deps.options?.loadImage;
  const read = await readImages(raw, deps.model, loadImage === undefined ? {} : { loadImage });
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

function bundleEvents(env: StepEnv, bundle: ContextBundle, ref: ArtifactRef, correctsSeq?: number, reason?: string): NewEvent[] {
  const counts = { bundle: ref, includedCount: bundle.included.length, excludedCount: bundle.excluded.length };
  const head =
    correctsSeq === undefined
      ? newEvent(env, 'context-assembled', counts)
      : newEvent(env, 'corrected', { correctsSeq, fields: { ...counts }, reason: reason ?? 'scope changed' });
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
 * and correct `context-assembled` to point at it (the reporter corrected the scope); the card is then
 * shown again. Looks right, a timeout, or a Widen past `maxScopeRounds` goes on to resolve.
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
      bundleEvents(env, bundle, await putBundle(env, tx, bundle, assembled.payload.bundle.artifactId), assembled.seq, `${choice} tapped by ${who(answer)}`),
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
 * row); `create-anyway`, `not-related`, or a timeout goes on. Either way the pending decision is
 * corrected to what was decided.
 */
export async function dedupeCardStep(env: StepEnv, phase: Extract<Phase, { kind: 'dedupe-card' }>): Promise<StepResult> {
  const checked = must(env.cursor.dedupe, 'dedupe-checked');
  const top = checked.result.candidates[0];
  const answer = phase.answer;
  if (answer !== undefined && answer.payload.choice === 'link' && top !== undefined) {
    return linkStep(env, checked.seq, top.issueKey, `link tapped by ${who(answer)}`);
  }
  let reason: string;
  if (answer !== undefined || top === undefined) reason = answer === undefined ? 'no candidate to link' : `${answer.payload.choice} tapped by ${who(answer)}`;
  else if (takeTimeout(env)) reason = `no answer within ${hours(tapTimeoutMs(env))}`;
  else {
    const card: InteractiveCard = { kind: 'dedupe', issueKey: top.issueKey, summary: top.summary, ...(top.assignee === undefined ? {} : { assignee: top.assignee }) };
    return awaitCard(env, card, env.payload.reporter.id);
  }
  await commit(env, [newEvent(env, 'corrected', { correctsSeq: checked.seq, fields: { decision: 'create-anyway' }, reason }), ...ended(env)]);
  return 'continue';
}

async function linkStep(env: StepEnv, dedupeSeq: number, issueKey: string, reason: string): Promise<StepResult> {
  const where = env.payload.context.deepLink ?? `${env.payload.source} channel ${env.payload.context.channelId}`;
  // Status first: a crash before the append repeats it, which beats never sending it.
  const text = `Already tracked as ${issueKey}; I added this report to it.`;
  await subscribeStatus(env, issueKey, text, text);
  await commit(
    env,
    [newEvent(env, 'corrected', { correctsSeq: dedupeSeq, fields: { decision: 'link' }, reason }), newEvent(env, 'linked-to-existing', { issueKey })],
    async (tx) => {
      await tx.enqueueOutbox(outboxRow(env, 'add-comment', { issueKey, text: `Another report of this from ${env.payload.reporter.name}: ${where}` }));
      return [];
    },
  );
  return 'continue';
}

/**
 * main 7: the ask-back gate. A question that passes is recorded as `clarified` (asked, no answer yet)
 * and posted; one that fails the gate is not asked and the ticket gets `needs-clarification`. The
 * answer is recorded but does not change the resolution yet (#115).
 */
export async function clarifyStep(env: StepEnv): Promise<StepResult> {
  const bundle = await loadBundle(env);
  const resolution = must(env.cursor.resolved, 'resolved').resolution;
  const evidence = (await env.deps.evidence?.(env.payload, resolution)) ?? {};
  const question = await maybeAsk(env.payload, bundle, resolution, env.map, env.deps.model, {
    ...evidence,
    questionsAsked: env.cursor.clarified.length,
  });
  if (question?.gatePassed !== true) return planStep(env, question !== undefined, bundle);
  const waitFor = question.audience === 'engineer' ? resolution.ownerId : env.payload.reporter.id;
  const asked = newEvent(env, 'clarified', { audience: question.audience, question: question.text, timedOut: false });
  return awaitCard(env, { kind: 'clarify', question }, waitFor, [asked]);
}

/** The clarify card: the answer (or the timeout) corrects the asked `clarified` event. */
export async function clarifyCardStep(env: StepEnv, phase: Extract<Phase, { kind: 'clarify-card' }>): Promise<StepResult> {
  const last = must(env.cursor.clarified[env.cursor.clarified.length - 1], 'clarified');
  const answer = phase.answer;
  let fields: Record<string, unknown>;
  let reason: string;
  if (answer !== undefined) {
    fields = { answer: answer.payload.choice };
    reason = `answered by ${who(answer)}`;
  } else if (takeTimeout(env)) {
    fields = { timedOut: true };
    reason = `no answer within ${hours(tapTimeoutMs(env))}`;
  } else {
    // A repost after a crash: the options were not recorded, so the question goes out as free text.
    const resolution = must(env.cursor.resolved, 'resolved').resolution;
    const { audience, question } = last.payload;
    const waitFor = audience === 'engineer' ? resolution.ownerId : env.payload.reporter.id;
    return awaitCard(env, { kind: 'clarify', question: { audience, text: question, gatePassed: true, gateFailures: [] } }, waitFor);
  }
  await commit(env, [newEvent(env, 'corrected', { correctsSeq: last.seq, fields, reason }), ...ended(env)]);
  return 'continue';
}

function synthesisContext(env: StepEnv, resolution: Resolution, needsClarification: boolean): SynthesisContext {
  const surface = resolution.surfaceId === undefined ? undefined : findSurface(env.map, resolution.surfaceId);
  return { payload: env.payload, resolution, ...(surface === undefined ? {} : { surface }), needsClarification };
}

function createIssueRow(issue: SynthesizedIssue): CreateIssueRow {
  return {
    fields: issue.fields,
    customFields: issue.customFields,
    ...(issue.suggestedAssigneeEmail === undefined ? {} : { suggestedAssigneeEmail: issue.suggestedAssigneeEmail }),
    ...(issue.promptErrors.length === 0 ? {} : { promptErrors: issue.promptErrors }),
  };
}

/**
 * main 8 and 9: triage plan, autonomy level (from policy, inside `plan`), and ticket synthesis. The
 * implementation request is stored as an artifact. Levels 0, 2, 3 enqueue `create-issue` with
 * `planned`; level 1 shows the fix preview first. A `noop` plan ends the incident as not a bug.
 */
export async function planStep(env: StepEnv, needsClarification: boolean, known?: ContextBundle): Promise<StepResult> {
  const bundle = known ?? (await loadBundle(env));
  const resolution = must(env.cursor.resolved, 'resolved').resolution;
  const checked = must(env.cursor.dedupe, 'dedupe-checked').result;
  const drafted = await plan(env.payload, bundle, resolution, checked, env.map, env.deps.model, env.deps.repoReader?.(resolution));
  if (drafted.action === 'noop') {
    await commit(env, [newEvent(env, 'not-a-bug', { reason: 'triage found nothing to file' })]);
    return 'continue';
  }
  // The dedupe card already decided: candidates reach triage only after Create anyway (or its
  // timeout), so a `link_existing` draft is filed as a new issue rather than overruling that choice.
  const { linkTo: _linkTo, ...unlinked } = drafted;
  const decided: TriageResolutionPlan = drafted.action === 'link_existing' ? { ...unlinked, action: 'create_issue' } : drafted;
  const triaged: TriageResolutionPlan = needsClarification ? { ...decided, labels: [...new Set([...decided.labels, LABEL_NEEDS_CLARIFICATION])] } : decided;
  const level = triaged.autonomyLevel;
  const issue = await synthesizeIssue(triaged, bundle, level, synthesisContext(env, resolution, needsClarification));
  const prompt = issue.customFields['Implementation Prompt'];
  await commit(env, [], async (tx) => {
    const ref =
      prompt === ''
        ? undefined
        : await tx.putArtifact({
            workspaceId: env.deps.workspaceId,
            incidentId: env.cursor.incidentId,
            kind: 'implementation-request',
            contentType: 'application/xml',
            body: prompt,
            createdBy: agentName(env),
          });
    if (level !== 1) await tx.enqueueOutbox(outboxRow(env, 'create-issue', createIssueRow(issue)));
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
        ...(ref === undefined ? {} : { implementationRequest: { artifactId: ref.id, version: ref.version } }),
      }),
    ];
  });
  if (level !== 1) return 'continue';
  env.cursor.waiting = false; // `planned` changed the status, which ends any wait
  return awaitCard(env, { kind: 'fix-preview', plan: triaged }, resolution.ownerId);
}

/**
 * The plan as `planned` recorded it. Interim until #114: the model's ADF write-up and
 * the suggested assignee are not in the log, so a plan rebuilt after a park has an empty description
 * body; the ticket keeps its structured description and the stored implementation request.
 */
function plannedPlan(env: StepEnv): TriageResolutionPlan {
  const p = must(env.cursor.planned, 'planned').payload;
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
    autonomyLevel: env.cursor.level ?? p.autonomyLevel,
  };
}

async function plannedIssue(env: StepEnv): Promise<SynthesizedIssue> {
  const planned = must(env.cursor.planned, 'planned').payload;
  const resolution = must(env.cursor.resolved, 'resolved').resolution;
  const triaged = plannedPlan(env);
  const issue = await synthesizeIssue(triaged, await loadBundle(env), triaged.autonomyLevel, synthesisContext(env, resolution, triaged.labels.includes(LABEL_NEEDS_CLARIFICATION)));
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
 * the `create-issue` row; whether the fixer starts is read from the tap after `filed`.
 */
export async function fixPreviewStep(env: StepEnv, phase: Extract<Phase, { kind: 'fix-preview' }>): Promise<StepResult> {
  const answer = phase.answer;
  if (answer === undefined && !takeTimeout(env)) {
    const resolution = must(env.cursor.resolved, 'resolved').resolution;
    return awaitCard(env, { kind: 'fix-preview', plan: plannedPlan(env) }, resolution.ownerId);
  }
  if (answer?.payload.choice === 'dismiss') {
    await commit(env, [newEvent(env, 'not-a-bug', { reason: `dismissed at the fix preview by ${who(answer)}` })]);
    return 'continue';
  }
  const issue = await plannedIssue(env);
  await commit(env, [newEvent(env, 'waiting-changed', {})], async (tx) => {
    await tx.enqueueOutbox(outboxRow(env, 'create-issue', createIssueRow(issue)));
    return [];
  });
  return 'continue';
}

function filedText(issueKey: string, owner: string | undefined, note?: string): string {
  const base = `Filed as ${issueKey}${owner === undefined ? '' : `, assigned to @${owner}`}.`;
  return note === undefined ? base : `${base} ${note}`;
}

/** Status loopback through `deps.status`, or a plain `filed` status through the adapter without one. */
async function subscribeStatus(env: StepEnv, issueKey: string, text: string, note?: string): Promise<void> {
  if (env.deps.status !== undefined) {
    await env.deps.status.subscribe(env.payload, issueKey, note);
    return;
  }
  await adapterFor(env)?.postStatus(env.payload, { issueKey, stage: 'filed', text });
}

/**
 * After the outbox worker appends `filed` (phase 3; tests append it) and continues the job: level 2
 * and 3, and level 1 after Fix it, move the issue to In Progress (an outbox row; the fixer webhook
 * fires on it). Level 2 and 3 post the informational fix preview with Stop. Every level subscribes
 * the reporter to status and records who the incident now waits on, which marks this step done.
 */
export async function afterFiledStep(env: StepEnv): Promise<StepResult> {
  const { cursor } = env;
  const issueKey = must(cursor.filed, 'filed').jiraKey;
  const planned = must(cursor.planned, 'planned');
  const resolution = must(cursor.resolved, 'resolved').resolution;
  const level = cursor.level ?? planned.payload.autonomyLevel;
  const fixer = level >= 2 || (level === 1 && approvedFix(cursor));
  const timedOut = level === 1 && answerAfter(cursor, 'fix-preview', planned.seq) === undefined;

  await rememberIncident(env.deps.cache, resolution, { issueKey, summary: planned.payload.summary });
  if (level >= 2) await adapterFor(env)?.postInteractive(env.payload, { kind: 'fix-preview', plan: plannedPlan(env) });
  const note = timedOut ? `Nobody tapped Fix it within ${hours(tapTimeoutMs(env))}, so this is filed as ticket only.` : undefined;
  const owner = resolution.ownerId;
  await subscribeStatus(env, issueKey, filedText(issueKey, owner, note), note);

  const waitingOn: WaitingOn | undefined = fixer ? undefined : { kind: 'human', ...(owner === undefined ? {} : { who: owner }) };
  await commit(env, [newEvent(env, 'waiting-changed', waitingOn === undefined ? {} : { waitingOn })], async (tx) => {
    if (fixer) await tx.enqueueOutbox(outboxRow(env, 'transition', { issueKey, to: IN_PROGRESS }));
    return [];
  });
  return 'continue';
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
      return planStep(env, phase.needsClarification);
    case 'fix-preview':
      return fixPreviewStep(env, phase);
    case 'after-filed':
      return afterFiledStep(env);
  }
}
