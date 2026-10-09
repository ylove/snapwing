// StateStore: the StatePort (B 1) over Kysely. Every method delegates one-to-one to a function in
// events.ts, projections/index.ts, artifacts.ts, inbox.ts, outbox.ts, config.ts, identities.ts,
// capture-tokens.ts, run-credentials.ts, or kv.ts, passing the store's context, so each of those files is filled in
// without touching this one.
// Construct through `openState` (db.ts); `transaction` hands `fn` a store bound to the transaction.

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
  Subscription,
} from '../contracts/state.ts';
import type {
  CaptureTokenInfo,
  IssuedCaptureToken,
  LinkedIdentity,
  LinkedIdentityKey,
  NewCaptureToken,
  NewLinkedIdentity,
  StatePort,
  VerifiedCaptureToken,
} from '../ports/state.ts';
import * as artifacts from './artifacts.ts';
import * as captureTokens from './capture-tokens.ts';
import * as config from './config.ts';
import { inTransaction, type StateContext } from './context.ts';
import * as events from './events.ts';
import * as identities from './identities.ts';
import * as inbox from './inbox.ts';
import * as kv from './kv.ts';
import * as outbox from './outbox.ts';
import * as projections from './projections/index.ts';
import * as runCredentials from './run-credentials.ts';
import type { ArtifactLimits, ModelRequestLimits, RunCredentialsPort, RunCredentialUse, RunReservation } from './run-credentials.ts';

export class StateStore implements StatePort, RunCredentialsPort {
  /** The store's Kysely handle (root or transaction), codec, and clock. Internal to pipeline/src/state. */
  readonly ctx: StateContext;

  constructor(ctx: StateContext) {
    this.ctx = ctx;
  }

  get dialect(): StateDialect {
    return this.ctx.dialect;
  }

  // Event log

  append(incidentId: string, newEvents: NewEvent[], expectedSeq: number): Promise<{ seq: number }> {
    return events.append(this.ctx, incidentId, newEvents, expectedSeq);
  }

  read(incidentId: string, fromSeq?: number): Promise<IncidentEvent[]> {
    return events.read(this.ctx, incidentId, fromSeq);
  }

  readSince(cursor: string, limit: number): Promise<{ events: IncidentEvent[]; cursor: string }> {
    return events.readSince(this.ctx, cursor, limit);
  }

  // Projections

  getIncident(incidentId: string): Promise<IncidentView | null> {
    return projections.getIncident(this.ctx, incidentId);
  }

  findIncidents(q: IncidentQuery): Promise<IncidentView[]> {
    return projections.findIncidents(this.ctx, q);
  }

  getClaims(incidentId: string): Promise<Claim[]> {
    return projections.getClaims(this.ctx, incidentId);
  }

  getSubscriptions(incidentId: string): Promise<Subscription[]> {
    return projections.getSubscriptions(this.ctx, incidentId);
  }

  subscribe(sub: Subscription): Promise<void> {
    return projections.putStandingSubscription(this.ctx, sub);
  }

  unsubscribe(key: { workspaceId: string; userId: string; scopeKind: 'surface' | 'all'; scopeId?: string }): Promise<boolean> {
    return projections.removeStandingSubscription(this.ctx, key);
  }

  // Artifacts

  putArtifact(a: NewArtifact): Promise<{ id: string; version: number }> {
    return artifacts.putArtifact(this.ctx, a);
  }

  getArtifact(id: string, version?: number): Promise<Artifact> {
    return artifacts.getArtifact(this.ctx, id, version);
  }

  // Inbox / outbox

  seenWebhook(source: string, deliveryId: string, ttlSec: number): Promise<boolean> {
    return inbox.seenWebhook(this.ctx, source, deliveryId, ttlSec);
  }

  enqueueOutbox(item: OutboxItem): Promise<void> {
    return outbox.enqueueOutbox(this.ctx, item);
  }

  drainOutbox(target: OutboxTarget, limit: number, workspaceId?: string): Promise<OutboxItem[]> {
    return outbox.drainOutbox(this.ctx, target, limit, workspaceId);
  }

  ackOutbox(ids: string[]): Promise<void> {
    return outbox.ackOutbox(this.ctx, ids);
  }

  deferOutbox(id: string, nextAttempt: string, error?: string): Promise<void> {
    return outbox.deferOutbox(this.ctx, id, nextAttempt, error);
  }

  parkOutbox(id: string, error: string): Promise<void> {
    return outbox.parkOutbox(this.ctx, id, error);
  }

  listParkedOutbox(target: OutboxTarget, limit: number): Promise<OutboxItem[]> {
    return outbox.listParkedOutbox(this.ctx, target, limit);
  }

  dropOutbox(target: OutboxTarget, batchKey: string): Promise<string[]> {
    return outbox.dropOutbox(this.ctx, target, batchKey);
  }

  // Config cache

  putConfigVersion(kind: ConfigKind, hash: string, body: string): Promise<void> {
    return config.putConfigVersion(this.ctx, kind, hash, body);
  }

  getConfigVersion(kind: ConfigKind): Promise<ConfigVersion> {
    return config.getConfigVersion(this.ctx, kind);
  }

  // Linked identities

  linkIdentity(identity: NewLinkedIdentity): Promise<void> {
    return identities.linkIdentity(this.ctx, identity);
  }

  getLinkedIdentity(key: LinkedIdentityKey): Promise<LinkedIdentity | null> {
    return identities.getLinkedIdentity(this.ctx, key);
  }

  getLinkedIdentityByGithubUser(workspaceId: string, githubUserId: number): Promise<LinkedIdentity | null> {
    return identities.getLinkedIdentityByGithubUser(this.ctx, workspaceId, githubUserId);
  }

  unlinkIdentity(key: LinkedIdentityKey): Promise<boolean> {
    return identities.unlinkIdentity(this.ctx, key);
  }

  // Capture tokens

  issueCaptureToken(token: NewCaptureToken): Promise<IssuedCaptureToken> {
    return captureTokens.issueCaptureToken(this.ctx, token);
  }

  verifyCaptureToken(token: string): Promise<VerifiedCaptureToken | null> {
    return captureTokens.verifyCaptureToken(this.ctx, token);
  }

  revokeCaptureToken(id: string): Promise<boolean> {
    return captureTokens.revokeCaptureToken(this.ctx, id);
  }

  listCaptureTokens(workspaceId: string): Promise<CaptureTokenInfo[]> {
    return captureTokens.listCaptureTokens(this.ctx, workspaceId);
  }

  // Runner container run credentials (#273; not part of StatePort)

  runCredentialUse(runId: string): Promise<RunCredentialUse | undefined> {
    return runCredentials.runCredentialUse(this.ctx, runId);
  }

  runCredentialsRevoked(runId: string): Promise<boolean> {
    return runCredentials.runCredentialsRevoked(this.ctx, runId);
  }

  revokeRunCredentials(runId: string): Promise<void> {
    return runCredentials.revokeRunCredentials(this.ctx, runId);
  }

  reserveModelRequest(runId: string, limits: ModelRequestLimits): Promise<RunReservation> {
    return runCredentials.reserveModelRequest(this.ctx, runId, limits);
  }

  recordModelTokens(runId: string, inputTokens: number, outputTokens: number): Promise<void> {
    return runCredentials.recordModelTokens(this.ctx, runId, inputTokens, outputTokens);
  }

  reserveArtifact(runId: string, bytes: number, limits: ArtifactLimits): Promise<RunReservation> {
    return runCredentials.reserveArtifact(this.ctx, runId, bytes, limits);
  }

  // kv (cache-port fallback; not part of StatePort)

  kvGet(k: string): Promise<string | undefined> {
    return kv.kvGet(this.ctx, k);
  }

  kvSet(k: string, v: string, ttlSec?: number): Promise<void> {
    return kv.kvSet(this.ctx, k, v, ttlSec);
  }

  kvSetIfAbsent(k: string, v: string, ttlSec?: number): Promise<boolean> {
    return kv.kvSetIfAbsent(this.ctx, k, v, ttlSec);
  }

  kvDelete(k: string): Promise<void> {
    return kv.kvDelete(this.ctx, k);
  }

  /** Deletes expired kv rows, `batch` at a time (default 500); resolves to how many went (#271). */
  kvSweepExpired(batch?: number): Promise<number> {
    return kv.kvSweepExpired(this.ctx, batch);
  }

  // Transactions

  /** See `StatePort.transaction`. Inside `fn`, use `tx`, not this store (on SQLite this store would wait on `tx`'s connection). */
  transaction<T>(fn: (tx: StateStore) => Promise<T>): Promise<T> {
    return inTransaction(this.ctx, (ctx) => fn(ctx === this.ctx ? this : new StateStore(ctx)));
  }
}
