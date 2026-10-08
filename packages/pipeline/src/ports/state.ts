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
export { ExpectedSeqConflictError, isExpectedSeqConflict, isParkedOutbox, LOG_START, StateNotFoundError, stateOptionsFromEnv } from '../contracts/state.ts';

/** The chat platform a linked identity's user belongs to. */
export type ChatPlatform = 'slack' | 'teams';

/** One chat user in one workspace: the key of a linked identity. */
export interface LinkedIdentityKey {
  workspaceId: string;
  chat: ChatPlatform;
  /** The platform's user id (Slack `U...`, Teams AAD object id). */
  chatUserId: string;
}

/**
 * A chat user's linked GitHub account (main 11.2, ADR 0007): the GitHub App user-to-server token
 * that lets a `Merge` tap act as that human. Token fields hold sealed values (`seal` in
 * `util/seal.ts`, AES-256-GCM under `SNAPWING_ENCRYPTION_KEY`), never a token; the store rejects a
 * value that is not sealed. Times are ISO 8601.
 */
export interface LinkedIdentity extends LinkedIdentityKey {
  githubLogin: string;
  githubUserId: number;
  /** Sealed user-to-server token. */
  accessToken: string;
  /** Absent when the App's user tokens do not expire. */
  accessTokenExpiresAt?: string;
  /** Sealed refresh token; absent when the App's user tokens do not expire. */
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
  /** When this chat user was linked to this GitHub account. */
  linkedAt: string;
  /** When the row last changed (a link or a token refresh). */
  updatedAt: string;
}

export type NewLinkedIdentity = Omit<LinkedIdentity, 'linkedAt' | 'updatedAt'>;

/** What `issueCaptureToken` takes: whose token it is, and an optional label ("laptop", "ci"). */
export interface NewCaptureToken {
  workspaceId: string;
  /** The map handle of the person the token identifies (main 15.3); the caller checks it is in the map. */
  person: string;
  label?: string;
}

/**
 * A per-user capture token as listed (main 15.3, 15.4, ADR 0007): never the token or its hash. Times
 * are ISO 8601.
 */
export interface CaptureTokenInfo {
  /** ULID; what `revokeCaptureToken` takes. */
  id: string;
  workspaceId: string;
  person: string;
  label?: string;
  issuedAt: string;
  /** The last successful `verifyCaptureToken`; absent when never used. */
  lastUsedAt?: string;
  /** Absent while the token is live. */
  revokedAt?: string;
}

/** What `issueCaptureToken` resolves to: the row plus the token, the only time the token exists in the clear. */
export interface IssuedCaptureToken extends CaptureTokenInfo {
  token: string;
}

/** Who a verified capture token identifies. */
export interface VerifiedCaptureToken {
  workspaceId: string;
  person: string;
  tokenId: string;
}

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
   * while a write is in flight (on Postgres, any write transaction in this database), and the events
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
  /**
   * Writes a standing subscription: scope `surface` ("keep me posted on the website") or `all`. One row
   * per person and scope; writing again changes its `channel`, and its `platform` when one is given.
   * Rebuild keeps these rows (they are not derived from events). Rejects with a TypeError for scope
   * `incident` (the `watch` signal writes those) or a surface scope without `scopeId`.
   */
  subscribe(sub: Subscription): Promise<void>;
  /** Removes a standing subscription; true when there was one. */
  unsubscribe(key: { workspaceId: string; userId: string; scopeKind: 'surface' | 'all'; scopeId?: string }): Promise<boolean>;

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
   * Up to `limit` rows for `target` (in `workspaceId` when given) with no `doneAt` and
   * `nextAttempt <= now`, oldest `createdAt` first (then `id`). Order holds per incident: a row is
   * withheld while an earlier undone row of the same incident and target is not yet due, so a
   * deferred row is never overtaken. Rows with no `incidentId` are independent. Does not mark them:
   * draining again before `ackOutbox` returns the same rows.
   */
  drainOutbox(target: OutboxTarget, limit: number, workspaceId?: string): Promise<OutboxItem[]>;
  /** Sets `doneAt` and clears `lastError` on each undone row. Unknown ids are ignored. */
  ackOutbox(ids: string[]): Promise<void>;
  /**
   * Moves an undone row's `nextAttempt` (ISO 8601). With `error`, the send failed: `attempts` goes
   * up by one and `lastError` is set. Without it the row is only held (a comment waiting out its
   * batch window), and nothing counts as a failure. Unknown or done ids are ignored.
   */
  deferOutbox(id: string, nextAttempt: string, error?: string): Promise<void>;
  /**
   * Gives up on an undone row: `attempts` up by one, `lastError = error`, `doneAt = now`. It leaves
   * the drain and stops holding back its incident's later rows; `listParkedOutbox` shows it.
   * Unknown or done ids are ignored.
   */
  parkOutbox(id: string, error: string): Promise<void>;
  /** Up to `limit` parked rows for `target` (see `isParkedOutbox`), most recently parked first. */
  listParkedOutbox(target: OutboxTarget, limit: number): Promise<OutboxItem[]>;
  /**
   * Drops the undone rows of `target` whose `batchKey` is `batchKey`: each gets `doneAt = now` (and no
   * `lastError`, so it is not parked) without being sent. Resolves to their ids, oldest first. B 7.3:
   * a human's edit of a Jira field drops the agent's pending write to that field. A row a projector
   * already drained is still sent; its later `ackOutbox` is then a no-op.
   */
  dropOutbox(target: OutboxTarget, batchKey: string): Promise<string[]>;

  // Config cache

  putConfigVersion(kind: ConfigKind, hash: string, body: string): Promise<void>;
  /** The most recently loaded version. Rejects with `StateNotFoundError` when none is loaded. */
  getConfigVersion(kind: ConfigKind): Promise<ConfigVersion>;

  // Linked identities (main 11.2, ADR 0007)

  /**
   * Links the chat user to a GitHub account, or updates the link (a re-link or a token refresh):
   * one row per `(workspaceId, chat, chatUserId)`. `linkedAt` is kept unless the GitHub account
   * changes. Rejects with a TypeError, writing nothing, when a token field is not a sealed value.
   */
  linkIdentity(identity: NewLinkedIdentity): Promise<void>;
  /** The chat user's link, or null when there is none. */
  getLinkedIdentity(key: LinkedIdentityKey): Promise<LinkedIdentity | null>;
  /** Removes the chat user's link; true when there was one. */
  unlinkIdentity(key: LinkedIdentityKey): Promise<boolean>;

  // Capture tokens (main 15.3, 15.4, 16, ADR 0007). Not derived from events: rebuild keeps them.

  /**
   * Issues a per-user bearer token for Raycast and the CLI: `CAPTURE_TOKEN_PREFIX` (`swc_`, in
   * `state/capture-tokens.ts`) plus 32 random bytes, base64url. Resolves to it once; the store keeps
   * only its SHA-256 with the person, the label, and `issuedAt`, so the token cannot be shown again.
   */
  issueCaptureToken(token: NewCaptureToken): Promise<IssuedCaptureToken>;
  /**
   * Who `token` identifies, or null when it is unknown, revoked, or not a capture token. Compares the
   * SHA-256 in constant time and stamps `lastUsedAt` on a match.
   */
  verifyCaptureToken(token: string): Promise<VerifiedCaptureToken | null>;
  /** Revokes one token by id, leaving the person's others live; true when a live token was revoked. */
  revokeCaptureToken(id: string): Promise<boolean>;
  /** The workspace's tokens, revoked ones included, oldest first; never a token or its hash. */
  listCaptureTokens(workspaceId: string): Promise<CaptureTokenInfo[]>;

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
