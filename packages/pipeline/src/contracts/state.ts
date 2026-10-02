// State contracts: the types the StatePort (Companion B 1) reads and writes, one per B 3 table it
// exposes. Interface only; implementations live in pipeline/src/state (#16 onward). Storage choices
// (query builder, migrations, how jsonb, timestamptz, and boolean map on SQLite) are ADR 0011.
//
// Mapping rules, the same for every type in this file:
// - Column `snake_case` becomes property `camelCase`.
// - A nullable column is an optional property, absent (never `undefined`, never `null`) when the
//   column is null. `exactOptionalPropertyTypes` enforces this.
// - `timestamptz` is an ISO 8601 UTC string with milliseconds and a `Z` suffix, on both dialects.
// - `jsonb` is a parsed JSON value; `boolean` is a JS boolean, on both dialects.
// - IDs are ULIDs.

import type { AutonomyLevel } from './events.ts';
import type { ChannelSource } from './incident.ts';
import type { LifecycleStatus } from '../lifecycle/machine.ts';

export type { NewEvent, IncidentEvent } from './events.ts';

// Dialect switch ----------------------------------------------------------------------------------

export type StateDialect = 'sqlite' | 'postgres';

export const STATE_DIALECTS: readonly StateDialect[] = Object.freeze(['sqlite', 'postgres'] as const);

/**
 * What `openState` (`pipeline/src/state/db.ts`) takes. On Postgres `url` is the connection string
 * (`DATABASE_URL`); on SQLite it is the database file path, and the implementation picks a default
 * when it is absent.
 */
export interface StateOptions {
  dialect: StateDialect;
  url?: string;
}

/**
 * The one dialect switch: `SNAPWING_DB` is `sqlite` (the default when unset or empty) or `postgres`;
 * Postgres reads `DATABASE_URL`, which must then be non-empty. Any other `SNAPWING_DB` value throws,
 * so a typo never silently falls back to SQLite.
 */
export function stateOptionsFromEnv(env: Readonly<Record<string, string | undefined>>): StateOptions {
  const raw = env['SNAPWING_DB']?.trim() ?? '';
  const dialect = raw === '' ? 'sqlite' : raw;
  if (dialect === 'sqlite') {
    return { dialect: 'sqlite' };
  }
  if (dialect === 'postgres') {
    const url = env['DATABASE_URL']?.trim() ?? '';
    if (url === '') {
      throw new Error('SNAPWING_DB=postgres needs DATABASE_URL');
    }
    return { dialect: 'postgres', url };
  }
  throw new Error(`SNAPWING_DB must be one of ${STATE_DIALECTS.join(', ')}; got ${JSON.stringify(raw)}`);
}

// Errors ------------------------------------------------------------------------------------------

/**
 * `append` was called with an `expectedSeq` that is not the incident's current last seq: another
 * writer appended first. Never ignored; the caller re-reads the log and retries (CONTEXT.md rule 1).
 */
export class ExpectedSeqConflictError extends Error {
  override readonly name = 'ExpectedSeqConflictError';
  readonly code = 'EXPECTED_SEQ_CONFLICT';
  readonly incidentId: string;
  readonly expectedSeq: number;
  readonly actualSeq: number;

  constructor(incidentId: string, expectedSeq: number, actualSeq: number, options?: { cause?: unknown }) {
    super(`incident ${incidentId}: expected seq ${expectedSeq}, log is at ${actualSeq}`, options);
    this.incidentId = incidentId;
    this.expectedSeq = expectedSeq;
    this.actualSeq = actualSeq;
  }
}

/** Duck-typed check that also holds across duplicate module instances, where `instanceof` does not. */
export function isExpectedSeqConflict(e: unknown): e is ExpectedSeqConflictError {
  return e instanceof ExpectedSeqConflictError || (e instanceof Error && (e as { code?: unknown }).code === 'EXPECTED_SEQ_CONFLICT');
}

/** `getArtifact` or `getConfigVersion` found no row. Both B 1 signatures return a value, not null. */
export class StateNotFoundError extends Error {
  override readonly name = 'StateNotFoundError';
  readonly code = 'STATE_NOT_FOUND';
  readonly entity: 'artifact' | 'config-version';
  readonly key: string;

  constructor(entity: 'artifact' | 'config-version', key: string) {
    super(`${entity} not found: ${key}`);
    this.entity = entity;
    this.key = key;
  }
}

// Event log ---------------------------------------------------------------------------------------

/** `readSince` cursor that starts at the beginning of the log. Every other cursor is opaque. */
export const LOG_START = '';

// Projections: incidents --------------------------------------------------------------------------

/** `incidents.status`: a B 5 lifecycle state, the `LifecycleStatus` union of the reducer (#11). */
export type IncidentStatus = LifecycleStatus;

export type IncidentKind = 'incident' | 'work-item';

/** `incidents.waiting_on` (`{kind, who, since}`). The column is null when nothing is awaited. */
export interface IncidentWaitingOn {
  /** The A 7 `StatusAnswer.waitingOn` kinds, minus `nothing`, which is the absent value. */
  kind: 'ci' | 'review' | 'human' | 'deploy' | 'hold';
  who?: string;
  since: string;
}

/** One `incidents` row (B 3): the rebuildable current state of an incident or child work item. */
export interface IncidentView {
  id: string;
  workspaceId: string;
  /** Set on child work items (B 6). */
  parentId?: string;
  kind: IncidentKind;
  /** The seq of the last event folded into this row. */
  lastSeq: number;
  status: IncidentStatus;
  surfaceId?: string;
  componentId?: string;
  repo?: string;
  jiraKey?: string;
  prNumber?: number;
  branch?: string;
  /** A Jira priority name; a human may set any value in Jira (B 7.3), so not a closed union. */
  priority?: string;
  autonomyLevel?: AutonomyLevel;
  assigneeId?: string;
  reporterId?: string;
  source: ChannelSource;
  channelId?: string;
  anchorId?: string;
  /** The pinned status message. */
  statusMsgId?: string;
  summary?: string;
  waitingOn?: IncidentWaitingOn;
  monitored: boolean;
  openedAt: string;
  closedAt?: string;
  updatedAt: string;
}

/**
 * `findIncidents` filter (B 1: "by surface, status, key, text"). Every present field must match
 * (AND). Results are ordered by `updatedAt` descending, then `id`, and capped at `limit`.
 */
export interface IncidentQuery {
  workspaceId?: string;
  surfaceId?: string;
  /** One status, or any of several. An empty array matches nothing. */
  status?: IncidentStatus | readonly IncidentStatus[];
  /** Exact `incidents.jira_key`. */
  jiraKey?: string;
  /** Case-insensitive substring of `incidents.summary`. */
  text?: string;
  /** Children of a parent incident (B 6). */
  parentId?: string;
  kind?: IncidentKind;
  /** Default and maximum are the implementation's; it must be a positive integer. */
  limit?: number;
}

// Projections: claims and subscriptions -----------------------------------------------------------

/**
 * One `claims` row (B 3). A 7's `Claim` (`contracts/signals.ts`) is the rendered form, with the
 * claimer resolved through the workspace map; this is what the store holds.
 */
export interface Claim {
  incidentId: string;
  claimerId: string;
  since: string;
  lastActivity: string;
  expiresAt: string;
  /** Set together with `holdExpiresAt` while an environment hold is active. */
  holdEnv?: string;
  holdExpiresAt?: string;
}

export type SubscriptionScopeKind = 'incident' | 'surface' | 'all';

/** One `subscriptions` row (B 3). */
export interface Subscription {
  workspaceId: string;
  userId: string;
  scopeKind: SubscriptionScopeKind;
  /** The incident or surface id; absent for scope `all` (stored as a sentinel, ADR 0011). */
  scopeId?: string;
  channel: 'thread' | 'dm';
  createdAt: string;
}

// Artifacts ---------------------------------------------------------------------------------------

/** B 3 kinds, plus `plan`: the whole `TriageResolutionPlan` as JSON, referenced from `planned` (ADR 0015). */
export type ArtifactKind = 'implementation-request' | 'diagnosis' | 'contract' | 'review' | 'bundle' | 'plan';

export type ArtifactContentType = 'application/xml' | 'application/json';

/**
 * What `putArtifact` takes. Without `id` the store mints a ULID and writes version 1; with `id` it
 * writes the next version of that artifact. The store computes `sha256` (hex, of the UTF-8 body).
 */
export interface NewArtifact {
  id?: string;
  workspaceId: string;
  incidentId: string;
  kind: ArtifactKind;
  contentType: ArtifactContentType;
  body: string;
  /** Agent name or user id. */
  createdBy: string;
}

/** One `artifacts` row (B 3): an immutable version of an artifact. */
export interface Artifact {
  id: string;
  version: number;
  workspaceId: string;
  incidentId: string;
  kind: ArtifactKind;
  contentType: ArtifactContentType;
  /** Lowercase hex SHA-256 of the UTF-8 body. */
  sha256: string;
  body: string;
  createdBy: string;
  createdAt: string;
}

// Inbox and outbox --------------------------------------------------------------------------------

/** `webhook_inbox.source` values B 3 names. `seenWebhook` takes a plain string, as in B 1. */
export type WebhookSource = 'slack' | 'teams' | 'jira' | 'github' | 'ci' | 'alert';

export type OutboxTarget = 'jira' | 'github' | 'slack' | 'teams';

export const OUTBOX_TARGETS: readonly OutboxTarget[] = Object.freeze(['jira', 'github', 'slack', 'teams'] as const);

/** `outbox.op` values B 3 names; the list is open (`...`), so other strings are allowed. */
export type OutboxOp = 'create-issue' | 'update-fields' | 'add-comment' | 'transition' | 'edit-message' | (string & Record<never, never>);

/**
 * One `outbox` row (B 3), both what `enqueueOutbox` writes and what `drainOutbox` returns.
 * Enqueue writes the item as given, so the caller sets `attempts: 0` and takes `createdAt` and
 * `nextAttempt` from the event that implied the row (projections never read the wall clock).
 */
export interface OutboxItem {
  id: string;
  workspaceId: string;
  target: OutboxTarget;
  incidentId?: string;
  op: OutboxOp;
  /** Op-specific JSON object; the projector for `target` validates it. */
  payload: Record<string, unknown>;
  /** Comments with the same key within 60 s are merged (B 7.1, by the projector). */
  batchKey?: string;
  attempts: number;
  nextAttempt: string;
  lastError?: string;
  createdAt: string;
  /** Set by `ackOutbox`; a drained row never has it. */
  doneAt?: string;
}

// Config cache ------------------------------------------------------------------------------------

export type ConfigKind = 'map' | 'playbook' | 'instructions';

export const CONFIG_KINDS: readonly ConfigKind[] = Object.freeze(['map', 'playbook', 'instructions'] as const);

/** What `getConfigVersion` returns: the most recently loaded version of a kind. */
export interface ConfigVersion {
  hash: string;
  body: string;
}
