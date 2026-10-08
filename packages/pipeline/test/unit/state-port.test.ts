import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ExpectedSeqConflictError,
  LOG_START,
  StateNotFoundError,
  isExpectedSeqConflict,
  stateOptionsFromEnv,
  type Artifact,
  type Claim,
  type IncidentView,
  type LinkedIdentity,
  type NewArtifact,
  type NewLinkedIdentity,
  type NewEvent,
  type OpenState,
  type OutboxItem,
  type StatePort,
  type Subscription,
} from '../../src/ports/state.ts';
import type { NewEvent as CatalogNewEvent } from '../../src/contracts/events.ts';
import type { IncidentQuery } from '../../src/contracts/state.ts';
import type { LifecycleStatus } from '../../src/lifecycle/machine.ts';

const INC = '01JZ0000000000000000000002';

// B 3 columns, split by nullability. The type-level checks below prove each contract type has exactly
// these properties (camelCased), required for `not null` columns and optional for nullable ones.

type Camel<S extends string> = S extends `${infer H}_${infer T}` ? `${H}${Capitalize<Camel<T>>}` : S;
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];
type OptionalKeys<T> = Exclude<keyof T, RequiredKeys<T>>;

type IncidentsNotNull = 'id' | 'workspace_id' | 'kind' | 'last_seq' | 'status' | 'source' | 'monitored' | 'opened_at' | 'updated_at';
type IncidentsNullable =
  | 'parent_id' | 'surface_id' | 'component_id' | 'repo' | 'jira_key' | 'pr_number' | 'branch' | 'priority'
  | 'autonomy_level' | 'assignee_id' | 'owner_ref' | 'reporter_id' | 'channel_id' | 'anchor_id' | 'status_msg_id' | 'summary'
  | 'waiting_on' | 'closed_at';
type ClaimsNotNull = 'incident_id' | 'claimer_id' | 'since' | 'last_activity' | 'expires_at';
type ClaimsNullable = 'hold_env' | 'hold_expires_at';
// `scope_id` is in the primary key, so it is stored as a sentinel for scope `all` (ADR 0011) and
// surfaces as an optional property. `platform` is null when it was never recorded (0007).
type SubscriptionsNotNull = 'workspace_id' | 'user_id' | 'scope_kind' | 'channel' | 'created_at';
type SubscriptionsNullable = 'scope_id' | 'platform';
type ArtifactsNotNull = 'id' | 'version' | 'workspace_id' | 'incident_id' | 'kind' | 'content_type' | 'sha256' | 'body' | 'created_by' | 'created_at';
type OutboxNotNull = 'id' | 'workspace_id' | 'target' | 'op' | 'payload' | 'attempts' | 'next_attempt' | 'created_at';
type OutboxNullable = 'incident_id' | 'batch_key' | 'last_error' | 'done_at';

describe('contract types match the B 3 columns', () => {
  it('IncidentView is the incidents row', () => {
    expectTypeOf<RequiredKeys<IncidentView>>().toEqualTypeOf<Camel<IncidentsNotNull>>();
    expectTypeOf<OptionalKeys<IncidentView>>().toEqualTypeOf<Camel<IncidentsNullable>>();
    expectTypeOf<IncidentView['status']>().toEqualTypeOf<LifecycleStatus>();
    expectTypeOf<NonNullable<IncidentQuery['status']>>().toEqualTypeOf<LifecycleStatus | readonly LifecycleStatus[]>();
    expectTypeOf<IncidentView['monitored']>().toEqualTypeOf<boolean>();
    expectTypeOf<IncidentView['autonomyLevel']>().toEqualTypeOf<0 | 1 | 2 | 3 | undefined>();
  });

  it('Claim is the claims row', () => {
    expectTypeOf<RequiredKeys<Claim>>().toEqualTypeOf<Camel<ClaimsNotNull>>();
    expectTypeOf<OptionalKeys<Claim>>().toEqualTypeOf<Camel<ClaimsNullable>>();
  });

  it('Subscription is the subscriptions row', () => {
    expectTypeOf<RequiredKeys<Subscription>>().toEqualTypeOf<Camel<SubscriptionsNotNull>>();
    expectTypeOf<OptionalKeys<Subscription>>().toEqualTypeOf<Camel<SubscriptionsNullable>>();
  });

  it('Artifact is the artifacts row; NewArtifact leaves version, sha256, and createdAt to the store', () => {
    expectTypeOf<RequiredKeys<Artifact>>().toEqualTypeOf<Camel<ArtifactsNotNull>>();
    expectTypeOf<OptionalKeys<Artifact>>().toEqualTypeOf<never>();
    expectTypeOf<keyof NewArtifact>().toEqualTypeOf<Exclude<Camel<ArtifactsNotNull>, 'version' | 'sha256' | 'createdAt'>>();
    expectTypeOf<OptionalKeys<NewArtifact>>().toEqualTypeOf<'id'>();
  });

  it('OutboxItem is the outbox row', () => {
    expectTypeOf<RequiredKeys<OutboxItem>>().toEqualTypeOf<Camel<OutboxNotNull>>();
    expectTypeOf<OptionalKeys<OutboxItem>>().toEqualTypeOf<Camel<OutboxNullable>>();
  });

  it('LinkedIdentity is the linked_identities row (#153); NewLinkedIdentity leaves linkedAt and updatedAt to the store', () => {
    type NotNull = 'workspace_id' | 'chat' | 'chat_user_id' | 'github_login' | 'github_user_id' | 'access_token' | 'linked_at' | 'updated_at';
    type Nullable = 'access_token_expires_at' | 'refresh_token' | 'refresh_token_expires_at';
    expectTypeOf<RequiredKeys<LinkedIdentity>>().toEqualTypeOf<Camel<NotNull>>();
    expectTypeOf<OptionalKeys<LinkedIdentity>>().toEqualTypeOf<Camel<Nullable>>();
    expectTypeOf<keyof NewLinkedIdentity>().toEqualTypeOf<Exclude<Camel<NotNull | Nullable>, 'linkedAt' | 'updatedAt'>>();
  });

  it('NewEvent is the event catalog type, re-exported', () => {
    expectTypeOf<NewEvent>().toEqualTypeOf<CatalogNewEvent>();
  });
});

describe('StatePort signatures (B 1)', () => {
  it('append requires expectedSeq (deviation from B 1, ADR 0011)', () => {
    expectTypeOf<Parameters<StatePort['append']>>().toEqualTypeOf<[string, NewEvent[], number]>();
    expectTypeOf<ReturnType<StatePort['append']>>().toEqualTypeOf<Promise<{ seq: number }>>();
  });

  it('keeps the B 1 method set, plus the projector retry methods (#140), dropOutbox (#143), linked identities (#153), standing subscriptions (#329), and capture tokens (#374)', () => {
    expectTypeOf<keyof StatePort>().toEqualTypeOf<
      | 'append' | 'read' | 'readSince'
      | 'getIncident' | 'findIncidents' | 'getClaims' | 'getSubscriptions' | 'subscribe' | 'unsubscribe'
      | 'putArtifact' | 'getArtifact'
      | 'seenWebhook' | 'enqueueOutbox' | 'drainOutbox' | 'ackOutbox' | 'deferOutbox' | 'parkOutbox' | 'listParkedOutbox' | 'dropOutbox'
      | 'putConfigVersion' | 'getConfigVersion'
      | 'linkIdentity' | 'getLinkedIdentity' | 'unlinkIdentity'
      | 'issueCaptureToken' | 'verifyCaptureToken' | 'revokeCaptureToken' | 'listCaptureTokens'
      | 'transaction'
    >();
    expectTypeOf<Parameters<StatePort['drainOutbox']>[0]>().toEqualTypeOf<'jira' | 'github' | 'slack' | 'teams'>();
    expectTypeOf<Parameters<StatePort['getConfigVersion']>[0]>().toEqualTypeOf<'map' | 'playbook' | 'instructions'>();
  });

  it('openState resolves to a closable StatePort', () => {
    type Opened = Awaited<ReturnType<OpenState>>;
    expectTypeOf<Opened>().toExtend<StatePort>();
    expectTypeOf<Opened['close']>().toEqualTypeOf<() => Promise<void>>();
  });

  it('readSince starts from LOG_START', () => {
    expect(LOG_START).toBe('');
  });
});

describe('ExpectedSeqConflictError', () => {
  const err = new ExpectedSeqConflictError(INC, 3, 5);

  it('carries incidentId, expectedSeq, and actualSeq', () => {
    expect(err.incidentId).toBe(INC);
    expect(err.expectedSeq).toBe(3);
    expect(err.actualSeq).toBe(5);
    expectTypeOf(err.expectedSeq).toEqualTypeOf<number>();
  });

  it('is an Error with a stable name, code, and message', () => {
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ExpectedSeqConflictError);
    expect(err.name).toBe('ExpectedSeqConflictError');
    expect(err.code).toBe('EXPECTED_SEQ_CONFLICT');
    expect(err.message).toBe(`incident ${INC}: expected seq 3, log is at 5`);
  });

  it('keeps a cause', () => {
    const cause = new Error('unique violation');
    expect(new ExpectedSeqConflictError(INC, 0, 1, { cause }).cause).toBe(cause);
  });

  it('is recognised by instance or by code, and nothing else is', () => {
    expect(isExpectedSeqConflict(err)).toBe(true);
    const foreign = Object.assign(new Error('from another module copy'), { code: 'EXPECTED_SEQ_CONFLICT' });
    expect(isExpectedSeqConflict(foreign)).toBe(true);
    expect(isExpectedSeqConflict(new Error('other'))).toBe(false);
    expect(isExpectedSeqConflict({ code: 'EXPECTED_SEQ_CONFLICT' })).toBe(false);
    expect(isExpectedSeqConflict(undefined)).toBe(false);
  });
});

describe('StateNotFoundError', () => {
  it('names the entity and key', () => {
    const err = new StateNotFoundError('artifact', '01JZ00000000000000000000A1@2');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('StateNotFoundError');
    expect(err.code).toBe('STATE_NOT_FOUND');
    expect(err.entity).toBe('artifact');
    expect(err.message).toBe('artifact not found: 01JZ00000000000000000000A1@2');
  });
});

describe('stateOptionsFromEnv (the dialect switch)', () => {
  const PG = 'postgres://test-user@localhost:5432/test-db';

  it.each([{}, { SNAPWING_DB: '' }, { SNAPWING_DB: 'sqlite' }, { SNAPWING_DB: ' sqlite ', DATABASE_URL: PG }])(
    'selects SQLite for %o',
    (env) => {
      expect(stateOptionsFromEnv(env)).toEqual({ dialect: 'sqlite' });
    },
  );

  it('selects Postgres with DATABASE_URL', () => {
    expect(stateOptionsFromEnv({ SNAPWING_DB: 'postgres', DATABASE_URL: PG })).toEqual({ dialect: 'postgres', url: PG });
  });

  it.each([{ SNAPWING_DB: 'postgres' }, { SNAPWING_DB: 'postgres', DATABASE_URL: '' }])('rejects Postgres without a URL: %o', (env) => {
    expect(() => stateOptionsFromEnv(env)).toThrow('needs DATABASE_URL');
  });

  it.each(['pg', 'Postgres', 'mysql'])('rejects SNAPWING_DB=%s', (value) => {
    expect(() => stateOptionsFromEnv({ SNAPWING_DB: value })).toThrow('SNAPWING_DB must be one of sqlite, postgres');
  });

  it('matches the running CI matrix entry', () => {
    const opts = stateOptionsFromEnv(process.env);
    expect(['sqlite', 'postgres']).toContain(opts.dialect);
    if (opts.dialect === 'postgres') {
      expect(opts.url).toBeTruthy();
    }
  });
});
