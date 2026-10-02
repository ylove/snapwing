// src/ports/state.ts (Companion B 1). Types: contracts/state.ts. Storage: ADR 0011 (Kysely, one
// migration set on SQLite and Postgres). Implementation: pipeline/src/state, opened by
// `openState(options)` in state/db.ts (#16 onward).
//
// One deviation from B 1: `append`'s `expectedSeq` is required, not optional. Every append passes it
// (B 0, CONTEXT.md rule 1); ADR 0011 records the change.

import type {
  Artifact,
  Claim,
  ConfigKind,
  ConfigVersion,
  IncidentEvent,
  IncidentQuery,
  IncidentView,
  NewArtifact,
  NewEvent,
  OutboxItem,
  OutboxTarget,
  StateDialect,
  StateOptions,
  Subscription,
} from '../contracts/state.ts';

export type {
  Artifact,
  Claim,
  ConfigKind,
  ConfigVersion,
  IncidentEvent,
  IncidentQuery,
  IncidentView,
  NewArtifact,
  NewEvent,
  OutboxItem,
  OutboxTarget,
  StateDialect,
  StateOptions,
  Subscription,
} from '../contracts/state.ts';
export { ExpectedSeqConflictError, isExpectedSeqConflict, LOG_START, StateNotFoundError, stateOptionsFromEnv } from '../contracts/state.ts';

export interface StatePort {
  // Event log

  /**
   * Appends `events` (at least one, each with this `incidentId`) after seq `expectedSeq`, the last
   * seq the caller read (0 for a new incident). Assigns gapless seqs `expectedSeq + 1 ..` and
   * `recordedAt`, applies projections in the same transaction, and resolves to the last seq written.
   * Rejects with `ExpectedSeqConflictError` when the log is no longer at `expectedSeq`; nothing is
   * written then.
   */
  append(incidentId: string, events: NewEvent[], expectedSeq: number): Promise<{ seq: number }>;

  /** The incident's events with `seq >= fromSeq` (default 1), in seq order. Empty for an unknown incident. */
  read(incidentId: string, fromSeq?: number): Promise<IncidentEvent[]>;

  /**
   * Up to `limit` events across every incident after `cursor`, ordered by the transaction that
   * appended them, then `incidentId`, then `seq` (ADR 0013). Start from `LOG_START`; pass the
   * returned cursor back to continue. Cursors are opaque. An empty page returns the cursor it was
   * given. A cursor never passes an event that commits later: an event is withheld until every
   * transaction that could sort before it has finished, so a page may be empty, or short of `limit`,
   * while a write is in flight (on Postgres, any write transaction in the cluster), and the events
   * come on a later call. The order is not `recordedAt` order. On Postgres a transaction does not see
   * its own appends here.
   */
  readSince(cursor: string, limit: number): Promise<{ events: IncidentEvent[]; cursor: string }>;

  // Projections (derived, rebuildable)

  getIncident(incidentId: string): Promise<IncidentView | null>;
  /** By surface, status, key, text; see `IncidentQuery` for matching and order. */
  findIncidents(q: IncidentQuery): Promise<IncidentView[]>;
  getClaims(incidentId: string): Promise<Claim[]>;
  /**
   * Every subscription that covers the incident: scope `incident` on its id, scope `surface` on its
   * surface, and scope `all` in its workspace. Empty for an unknown incident.
   */
  getSubscriptions(incidentId: string): Promise<Subscription[]>;

  // Artifacts (versioned, content-addressed)

  putArtifact(a: NewArtifact): Promise<{ id: string; version: number }>;
  /** The latest version, or `version`. Rejects with `StateNotFoundError` when there is no such row. */
  getArtifact(id: string, version?: number): Promise<Artifact>;

  // Inbox / outbox

  /**
   * True if `(source, deliveryId)` was already seen and has not expired. Otherwise records it with
   * `expires_at = now + ttlSec` and returns false. Atomic: of two concurrent calls, one sees false.
   */
  seenWebhook(source: string, deliveryId: string, ttlSec: number): Promise<boolean>;
  enqueueOutbox(item: OutboxItem): Promise<void>;
  /**
   * Up to `limit` rows for `target` with no `doneAt` and `nextAttempt <= now`, oldest `createdAt`
   * first. Does not mark them: draining again before `ackOutbox` returns the same rows.
   */
  drainOutbox(target: OutboxTarget, limit: number): Promise<OutboxItem[]>;
  /** Sets `doneAt` on each row. Unknown ids are ignored. */
  ackOutbox(ids: string[]): Promise<void>;

  // Config cache

  putConfigVersion(kind: ConfigKind, hash: string, body: string): Promise<void>;
  /** The most recently loaded version. Rejects with `StateNotFoundError` when none is loaded. */
  getConfigVersion(kind: ConfigKind): Promise<ConfigVersion>;

  /**
   * Runs `fn` in one database transaction: commits when it resolves, rolls back and rejects when it
   * throws. `tx` is a StatePort bound to the transaction; calling `tx.transaction` joins it.
   */
  transaction<T>(fn: (tx: StatePort) => Promise<T>): Promise<T>;
}

/**
 * What `openState` returns: the port plus the lifecycle B 1 leaves out. Callers that only use state
 * take a `StatePort`; whoever opened the store closes it.
 */
export interface OpenedState extends StatePort {
  readonly dialect: StateDialect;
  /** Releases the SQLite handle or the Postgres pool. The store is unusable afterwards. */
  close(): Promise<void>;
}

/**
 * The factory signature `openState` in `pipeline/src/state/db.ts` implements (#16). Runs pending
 * migrations on open (B 10) and rejects, naming the migration, if one fails.
 */
export type OpenState = (options: StateOptions) => Promise<OpenedState>;
