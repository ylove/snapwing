// Event catalog: the vocabulary of the incident event log.
// Companion A 4.2 (event names) and A 7 (IncidentEvent); Companion B 3 (incident_events columns),
// B 4 (versioning and corrections), B 5 (lifecycle transitions), B 7.3 (Jira inbound), B 9 (fixer reporting).
//
// Parameterized names. A 4.2 writes `held:<env>` and `comment:<intent>`. They are modelled here as the
// plain types `held` and `comment`, with the environment in `payload.env` and the intent in
// `payload.intent`. This keeps `EventType` a closed union that a switch can exhaust, keeps the
// `incident_events.type` index (B 3) useful for "every hold" queries, and lets the environment and
// intent vocabularies grow without touching this file. `deployed:staging` and `deployed:production`
// stay literal names because A 4.2 and B 5 treat them as two distinct lifecycle steps.
//
// Where the specs are silent on a payload, it carries the minimum fields the B 3 projections
// (`incidents`, `claims`, `escalation_scores`) need, and says so in its doc comment. Bodies that the
// `artifacts` table stores (bundles, implementation requests, diagnoses, reviews) are referenced by
// `ArtifactRef`, never inlined. Coordination events (B 6) join this union with the coordinator.

import type {
  ChannelSource,
  ActorRole,
  DedupeResult,
  IncidentActor,
  MergeGateResult,
  Resolution,
  TriageResolutionPlan,
} from './incident.ts';
import type { Intent, SignalEvent } from './signals.ts';

// Event names -------------------------------------------------------------------------------------

/** Every event the incident log can hold. */
export type EventType =
  // A 4.2 main line
  | 'captured'
  | 'context-assembled'
  | 'resolved'
  | 'dedupe-checked'
  | 'clarified'
  | 'planned'
  | 'filed'
  | 'claimed'
  | 'fixer-started'
  | 'pr-opened'
  | 'review-passed'
  | 'review-failed'
  | 'ci-green'
  | 'ci-red'
  | 'merged'
  | 'deployed:staging'
  | 'verified'
  | 'deployed:production'
  | 'closed'
  // A 4.2 "at any point", and the B 5 "at any state" line
  | 'escalated'
  | 'stopped'
  | 'released'
  | 'held'
  | 'comment'
  | 'level-changed'
  | 'reverted'
  // B 5 branches and terminal states
  | 'resolution-signal'
  | 'linked-to-existing'
  | 'not-a-bug'
  | 'let-agent-take'
  // B 4 corrections
  | 'corrected'
  // B 7.3 Jira inbound
  | 'jira-priority-changed'
  | 'jira-assignee-changed'
  | 'jira-transitioned'
  // B 9 fixer reporting
  | 'fixer-checkpoint'
  | 'fixer-artifact'
  | 'fixer-done'
  | 'fixer-failed';

/** Every `EventType`, once, in log order where there is one. Frozen. */
export const EVENT_TYPES = Object.freeze([
  'captured',
  'context-assembled',
  'resolved',
  'dedupe-checked',
  'clarified',
  'planned',
  'filed',
  'claimed',
  'fixer-started',
  'pr-opened',
  'review-passed',
  'review-failed',
  'ci-green',
  'ci-red',
  'merged',
  'deployed:staging',
  'verified',
  'deployed:production',
  'closed',
  'escalated',
  'stopped',
  'released',
  'held',
  'comment',
  'level-changed',
  'reverted',
  'resolution-signal',
  'linked-to-existing',
  'not-a-bug',
  'let-agent-take',
  'corrected',
  'jira-priority-changed',
  'jira-assignee-changed',
  'jira-transitioned',
  'fixer-checkpoint',
  'fixer-artifact',
  'fixer-done',
  'fixer-failed',
] as const satisfies readonly EventType[]);

// Compile-time: EVENT_TYPES lists every member of EventType (the `satisfies` above rules out extras).
type MissingFromEventTypes = Exclude<EventType, (typeof EVENT_TYPES)[number]>;
const eventTypesComplete: [MissingFromEventTypes] extends [never] ? true : MissingFromEventTypes = true;
void eventTypesComplete;

const EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(EVENT_TYPES);

/** Runtime guard for values read back from `incident_events.type` or received over the wire. */
export function isEventType(s: string): s is EventType {
  return EVENT_TYPE_SET.has(s);
}

// Envelope ----------------------------------------------------------------------------------------

/** `incident_events.source` (B 3): the A 7 sources plus `fixer` (B 9). */
export type EventSource = 'slack' | 'teams' | 'jira' | 'github' | 'ci' | 'deploy' | 'agent' | 'cli' | 'fixer';

/**
 * `incident_events.actor_role` (B 3). The map roles, plus `human` for a person the map does not know,
 * such as a Jira user editing a field (B 7.3).
 */
export type EventActorRole = ActorRole | 'human';

/**
 * Who caused an event: exactly the `actor_id` and `actor_role` columns (B 3), so an event survives a
 * round trip through the log unchanged. An `IncidentActor` is assignable to it.
 */
export interface EventActor {
  id: string;
  role: EventActorRole;
}

export type AutonomyLevel = 0 | 1 | 2 | 3;

/** A versioned row in the `artifacts` table (B 3). */
export interface ArtifactRef {
  artifactId: string;
  version: number;
}

interface EventEnvelope {
  workspaceId: string;
  incidentId: string;
  /** Per-incident, gapless, assigned by `append` from `expectedSeq` (B 4). */
  seq: number;
  /** Event schema version; readers upcast old versions in `state/upcast.ts` (B 4). */
  v: number;
  source: EventSource;
  /** Absent when the agent, a timer, or the fixer acted on its own. */
  actor?: EventActor;
  /** When it happened in the world (ISO 8601). A 7 calls this `timestamp`. */
  occurredAt: string;
  /** When the log stored it (ISO 8601); set by the state port. */
  recordedAt: string;
}

/**
 * One row of the incident log, discriminated on `type`. Narrow with `event.type === 'held'` to get
 * `event.payload` as `HeldPayload`. This replaces A 7's loosely typed `IncidentEvent`: A 7's
 * `timestamp` is split into `occurredAt` and `recordedAt` to match the B 3 columns, `payload` is typed
 * per event, and `actor` holds only the columns the log stores.
 */
export type IncidentEvent<T extends EventType = EventType> = {
  [K in T]: EventEnvelope & { type: K; payload: EventPayloads[K] };
}[T];

/** What callers pass to `append(incidentId, events, expectedSeq)`: the state port assigns `seq` and `recordedAt`. */
export type NewEvent<T extends EventType = EventType> = T extends EventType
  ? Omit<IncidentEvent<T>, 'seq' | 'recordedAt'>
  : never;

// Payloads ----------------------------------------------------------------------------------------

/** Spec silent beyond A 7 and main 13; carries what `incidents` needs at open plus the redactable snapshot (B 4). */
export interface CapturedPayload {
  kind: 'incident' | 'work-item';
  /** Set on child work items (B 6). */
  parentId?: string;
  idempotencyKey: string;
  source: ChannelSource;
  reporter: IncidentActor;
  anchorText: string;
  /** The anchor message id; `incidents.anchor_id`. */
  anchorId?: string;
  channelId: string;
  threadId?: string;
  deepLink?: string;
  /** Removed by the nightly retention job after the window (B 4); readers must tolerate its absence. */
  rawPayloadSnapshot?: Record<string, unknown>;
}

/** Spec silent. The bundle body lives in `artifacts` (kind `bundle`); the projection needs only the transition. */
export interface ContextAssembledPayload {
  bundle: ArtifactRef;
  includedCount: number;
  excludedCount: number;
}

/** The thread already says it is fixed (B 5: captured to not-filed). Shape of `ContextBundle.resolutionSignal`. */
export interface ResolutionSignalPayload {
  messageId: string;
  text: string;
}

/** Feeds `incidents.surface_id`, `component_id`, `repo`. */
export type ResolvedPayload = Resolution;

export type DedupeCheckedPayload = DedupeResult;

/** The incident joined an existing issue (terminal). Feeds `incidents.jira_key`. */
export interface LinkedToExistingPayload {
  issueKey: string;
}

/** Spec silent. One ask-back round (main 7); the projection needs only the transition. */
export interface ClarifiedPayload {
  audience: 'reporter' | 'engineer';
  question: string;
  /** Absent when the question timed out and the pipeline went on without an answer. */
  answer?: string;
  timedOut: boolean;
}

/**
 * Spec silent. The triage plan without its large bodies: the ADF description and the implementation
 * request XML live in `artifacts`. Feeds `incidents.summary`, `priority`, `autonomy_level`.
 */
export interface PlannedPayload
  extends Pick<
    TriageResolutionPlan,
    'action' | 'linkTo' | 'projectKey' | 'issueType' | 'summary' | 'priority' | 'labels' | 'componentId' | 'autonomyLevel'
  > {
  implementationRequest?: ArtifactRef;
}

/**
 * Spec silent. Appended by the Jira outbox worker once `create-issue` succeeds, so the key is always
 * known. Feeds `incidents.jira_key`.
 */
export interface FiledPayload {
  jiraKey: string;
}

/** Spec silent. Feeds a `claims` row: `since` and `last_activity` are the event's `occurredAt`. */
export interface ClaimedPayload {
  claimerId: string;
  expiresAt: string;
}

/** Claim released or expired (B 5 timer rows), or an environment hold released. Deletes the matching `claims` row or clears its hold. */
export type ReleasedPayload =
  | { scope: 'claim'; claimerId: string; reason: 'requested' | 'expired'; restoredLevel?: AutonomyLevel }
  | { scope: 'hold'; env: string; reason: 'requested' | 'expired' };

/** The claimer hands the fix back to the agent (B 5: claimed to fixing). Deletes the `claims` row. */
export interface LetAgentTakePayload {
  claimerId: string;
}

/**
 * `held:<env>` from A 4.2, with the environment in `env` (see the file header). B 5 also holds a
 * mergeable PR at a gate, which has no environment. Feeds `claims.hold_env` and `hold_expires_at`.
 */
export type HeldPayload =
  | { kind: 'environment'; env: string; claimerId?: string; expiresAt: string }
  | { kind: 'gate'; reason: string; gate?: MergeGateResult };

/** Spec silent. One fixer attempt (main 10); the run id ties the B 9 reports to it. */
export interface FixerStartedPayload {
  runId: string;
  harness: string;
  attempt: number;
}

/** B 9 `checkpoint`. */
export interface FixerCheckpointPayload {
  phase: 'cloned' | 'branched' | 'implemented' | 'tested' | 'pushed' | 'pr-opened';
  detail: string;
}

/** B 9 `artifact`: the body is stored as a versioned artifact and referenced here. */
export interface FixerArtifactPayload {
  kind: 'diagnosis' | 'contract';
  artifact: ArtifactRef;
}

/** B 9 `done`. `testsAdded` is a count. */
export interface FixerDonePayload {
  prNumber: number;
  branch: string;
  summary: string;
  testsAdded: number;
}

/** B 9 `failed`. Also appended when the fixer budget timer cancels the run (B 5). */
export interface FixerFailedPayload {
  reason: string;
  partialBranch?: string;
  attempts: number;
}

/** Spec silent. By the fixer or by a human (B 5); `actor` says which. Feeds `incidents.pr_number`, `branch`. */
export interface PrOpenedPayload {
  prNumber: number;
  branch: string;
}

/** Spec silent. The review body lives in `artifacts` (kind `review`). */
export interface ReviewPassedPayload {
  prNumber: number;
  review?: ArtifactRef;
}

export interface ReviewFailedPayload {
  prNumber: number;
  verdict: 'request-changes' | 'escalate';
  reason: string;
  review?: ArtifactRef;
}

/** Spec silent. */
export interface CiGreenPayload {
  prNumber: number;
  headSha: string;
}

export interface CiRedPayload {
  prNumber: number;
  headSha: string;
  failingChecks: string[];
}

/** Spec silent. Records the level in force at merge time for the "who approved this" audit (A 4.2). */
export interface MergedPayload {
  prNumber: number;
  mergeCommitSha: string;
  levelAtMergeTime: AutonomyLevel;
}

/** Spec silent. Shared by `deployed:staging` and `deployed:production`. */
export interface DeployedPayload {
  commitSha: string;
  deploymentId?: string;
}

/** Spec silent. */
export interface VerifiedPayload {
  env: string;
  note?: string;
}

/** Spec silent. Feeds `incidents.closed_at` from `occurredAt`. */
export interface ClosedPayload {
  reason?: string;
}

/** Terminal (B 5). Usually follows a `not-a-bug` signal. */
export interface NotABugPayload {
  reason?: string;
}

/** Stop is not terminal; the incident returns to `filed` (B 5). Also what the fixer stop poll reads (B 9). */
export interface StoppedPayload {
  reason?: string;
}

/** Spec silent. One escalation ladder step fired. Feeds `escalation_scores.step_reached`. */
export interface EscalatedPayload {
  intent: 'trigger' | 'escalate';
  step: number;
  action: 'mention' | 'page' | 'post';
  score: number;
}

/**
 * `comment:<intent>` from A 4.2, with the intent in `intent` (see the file header). Records a chat or
 * Jira signal (A 1, B 7.3) that does not itself move the lifecycle; the reactor is the event's `actor`.
 */
export interface CommentPayload {
  intent: Intent;
  platform: SignalEvent['platform'] | 'jira';
  signalSource: SignalEvent['source'];
  /** Absent for Jira comments, which have no chat target. */
  target?: SignalEvent['target'];
  confidence: number;
  environment?: string;
  raw: string;
  /**
   * Present for counting intents (trigger, escalate, accept, reject). The weight and window are frozen
   * when the event is recorded so that rebuilding `escalation_scores` never depends on the current playbook.
   */
  count?: { weight: number; windowEndsAt: string };
}

/** Spec silent. Feeds `incidents.autonomy_level`. */
export interface LevelChangedPayload {
  from: AutonomyLevel;
  to: AutonomyLevel;
  reason: string;
}

/** Spec silent. After `merged` (B 5). */
export interface RevertedPayload {
  prNumber: number;
  revertPrNumber?: number;
  reason?: string;
}

/** B 4: events are never edited; a correction references the seq it corrects. */
export interface CorrectedPayload {
  correctsSeq: number;
  /** The corrected payload fields, validated by the reader of the corrected event type. */
  fields: Record<string, unknown>;
  reason: string;
}

/** B 7.3. Projections take the human's value. Feeds `incidents.priority`. */
export interface JiraPriorityChangedPayload {
  jiraKey: string;
  from?: string;
  to: string;
}

/** B 7.3. Feeds `incidents.assignee_id`; an absent `to` means unassigned. */
export interface JiraAssigneeChangedPayload {
  jiraKey: string;
  from?: string;
  to?: string;
}

/** B 7.3. */
export interface JiraTransitionedPayload {
  jiraKey: string;
  from: string;
  to: string;
}

/** The payload interface for each event type. */
export interface EventPayloads {
  captured: CapturedPayload;
  'context-assembled': ContextAssembledPayload;
  resolved: ResolvedPayload;
  'dedupe-checked': DedupeCheckedPayload;
  clarified: ClarifiedPayload;
  planned: PlannedPayload;
  filed: FiledPayload;
  claimed: ClaimedPayload;
  'fixer-started': FixerStartedPayload;
  'pr-opened': PrOpenedPayload;
  'review-passed': ReviewPassedPayload;
  'review-failed': ReviewFailedPayload;
  'ci-green': CiGreenPayload;
  'ci-red': CiRedPayload;
  merged: MergedPayload;
  'deployed:staging': DeployedPayload;
  verified: VerifiedPayload;
  'deployed:production': DeployedPayload;
  closed: ClosedPayload;
  escalated: EscalatedPayload;
  stopped: StoppedPayload;
  released: ReleasedPayload;
  held: HeldPayload;
  comment: CommentPayload;
  'level-changed': LevelChangedPayload;
  reverted: RevertedPayload;
  'resolution-signal': ResolutionSignalPayload;
  'linked-to-existing': LinkedToExistingPayload;
  'not-a-bug': NotABugPayload;
  'let-agent-take': LetAgentTakePayload;
  corrected: CorrectedPayload;
  'jira-priority-changed': JiraPriorityChangedPayload;
  'jira-assignee-changed': JiraAssigneeChangedPayload;
  'jira-transitioned': JiraTransitionedPayload;
  'fixer-checkpoint': FixerCheckpointPayload;
  'fixer-artifact': FixerArtifactPayload;
  'fixer-done': FixerDonePayload;
  'fixer-failed': FixerFailedPayload;
}

// Compile-time: EventPayloads has exactly one entry per EventType.
type PayloadKeysMatch = [keyof EventPayloads] extends [EventType]
  ? [EventType] extends [keyof EventPayloads]
    ? true
    : Exclude<EventType, keyof EventPayloads>
  : Exclude<keyof EventPayloads, EventType>;
const payloadKeysMatch: PayloadKeysMatch = true;
void payloadKeysMatch;
