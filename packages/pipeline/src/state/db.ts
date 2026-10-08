// State store factory and Kysely table types (Companion B 2, B 3, B 10; ADR 0011).
//
// `openState(options)` opens SQLite (`better-sqlite3`, WAL mode) or Postgres (`pg`), runs pending
// migrations before it resolves, and returns the StatePort plus `dialect` and `close()`. Tests pick
// the dialect with `stateOptionsFromEnv(process.env)` (`SNAPWING_DB`, `DATABASE_URL`) through
// test/helpers/db.ts.
//
// Row types below are the encoded, snake_case columns as stored (see codec.ts for the encoding);
// the port returns the camelCase contract types in contracts/state.ts. Columns with a default are
// optional on insert. jsonb, timestamptz, boolean, and numeric read back as `unknown`, `string |
// Date`, `boolean | number`, and `number | string` because the two drivers differ; decode them
// through the codec, never by hand.

import BetterSqlite3 from 'better-sqlite3';
import { Kysely, PostgresDialect, SqliteDialect, type ColumnType, type Generated } from 'kysely';
import pg from 'pg';
import type { StateOptions } from '../contracts/state.ts';
import type { OpenedState, OpenState } from '../ports/state.ts';
import { createCodec } from './codec.ts';
import { migrateState } from './migrations/index.ts';
import { StateStore } from './store.ts';

export { inTransaction, type StateContext } from './context.ts';

// Column encodings ---------------------------------------------------------------------------------

/** jsonb: written as JSON text; reads back parsed (Postgres) or as text (SQLite). */
type Json = ColumnType<unknown, string, string>;
type JsonOpt = ColumnType<unknown, string | null | undefined, string | null>;
/** timestamptz: written as an ISO string; reads back as a Date (Postgres) or the string (SQLite). */
type Ts = ColumnType<string | Date, string, string>;
type TsOpt = ColumnType<string | Date | null, string | null | undefined, string | null>;
type TsDefault = ColumnType<string | Date, string | undefined, string>;
/** boolean: written as 1 or 0; reads back as a boolean (Postgres) or a number (SQLite). */
type Bool = ColumnType<boolean | number, 0 | 1, 0 | 1>;
type BoolDefault = ColumnType<boolean | number, 0 | 1 | undefined, 0 | 1>;
/** numeric: reads back as a string on Postgres. */
type Numeric = ColumnType<number | string, number, number>;
type Opt<T> = ColumnType<T | null, T | null | undefined, T | null>;

// Tables (B 3, plus jobs and job_waits) ------------------------------------------------------------

export interface WorkspacesTable {
  id: string;
  slug: string;
  created_at: TsDefault;
}

export interface ConfigVersionsTable {
  workspace_id: string;
  kind: 'map' | 'playbook' | 'instructions';
  hash: string;
  body: string;
  valid: Bool;
  errors: JsonOpt;
  loaded_at: TsDefault;
}

export interface IncidentEventsTable {
  workspace_id: string;
  incident_id: string;
  seq: number;
  type: string;
  v: Generated<number>;
  source: string;
  actor_id: Opt<string>;
  actor_role: Opt<string>;
  payload: Json;
  occurred_at: Ts;
  recorded_at: TsDefault;
  /**
   * The `readSince` key (ADR 0013): the writing transaction's id on Postgres (column default), a
   * per-transaction counter that append writes on SQLite. bigint reads back as a string on Postgres.
   */
  tx_order: ColumnType<number | string, number | undefined, number>;
}

export interface IncidentsTable {
  id: string;
  workspace_id: string;
  parent_id: Opt<string>;
  kind: 'incident' | 'work-item';
  last_seq: Generated<number>;
  status: string;
  surface_id: Opt<string>;
  component_id: Opt<string>;
  repo: Opt<string>;
  jira_key: Opt<string>;
  pr_number: Opt<number>;
  branch: Opt<string>;
  priority: Opt<string>;
  autonomy_level: Opt<number>;
  assignee_id: Opt<string>;
  owner_ref: Opt<string>;
  reporter_id: Opt<string>;
  source: string;
  channel_id: Opt<string>;
  anchor_id: Opt<string>;
  status_msg_id: Opt<string>;
  summary: Opt<string>;
  waiting_on: JsonOpt;
  monitored: BoolDefault;
  opened_at: Ts;
  closed_at: TsOpt;
  updated_at: Ts;
}

export interface ClaimsTable {
  incident_id: string;
  claimer_id: string;
  since: Ts;
  last_activity: Ts;
  expires_at: Ts;
  hold_env: Opt<string>;
  hold_expires_at: TsOpt;
}

export interface SubscriptionsTable {
  workspace_id: string;
  user_id: string;
  scope_kind: 'incident' | 'surface' | 'all';
  /** '' for scope `all` (ADR 0011); the store maps it to an absent `scopeId`. */
  scope_id: string;
  channel: 'thread' | 'dm';
  /** The platform the person subscribed from; null when unknown (0007). */
  platform: Opt<'slack' | 'teams'>;
  created_at: TsDefault;
}

export interface EscalationScoresTable {
  incident_id: string;
  intent: string;
  reactor_ids: Json;
  score: Numeric;
  step_reached: Opt<number>;
  window_ends: Ts;
}

/** A message Snapwing posted, with its A 1.3 target role (#287). */
export interface BotMessagesTable {
  platform: 'slack' | 'teams';
  channel: string;
  message_id: string;
  workspace_id: string;
  incident_id: string;
  role: string;
  seq: number;
  posted_at: Ts;
}

export interface ArtifactsTable {
  id: string;
  version: number;
  workspace_id: string;
  incident_id: string;
  kind: string;
  content_type: string;
  sha256: string;
  body: string;
  created_by: string;
  created_at: TsDefault;
}

export interface WebhookInboxTable {
  source: string;
  delivery_id: string;
  received_at: TsDefault;
  expires_at: Ts;
}

export interface OutboxTable {
  id: string;
  workspace_id: string;
  target: string;
  incident_id: Opt<string>;
  op: string;
  payload: Json;
  batch_key: Opt<string>;
  attempts: Generated<number>;
  next_attempt: TsDefault;
  last_error: Opt<string>;
  created_at: TsDefault;
  done_at: TsOpt;
}

export interface KvTable {
  k: string;
  v: string;
  expires_at: TsOpt;
}

export type JobState = 'created' | 'retry' | 'active' | 'parked' | 'completed' | 'cancelled' | 'failed';

/** The in-process scheduler's job store (B 3, last paragraph; #23). */
export interface JobsTable {
  id: string;
  name: string;
  data: Json;
  state: JobState;
  start_after: Ts;
  singleton_key: Opt<string>;
  retry_count: Generated<number>;
  retry_limit: Generated<number>;
  retry_backoff: BoolDefault;
  resumed: JsonOpt;
  last_error: Opt<string>;
  created_at: TsDefault;
  started_at: TsOpt;
  completed_at: TsOpt;
}

/** One row per parked job (ADR 0012). */
export interface JobWaitsTable {
  job_id: string;
  wait_kind: string;
  /** `waitKeyString(waitingOn)` from ports/workflow.ts. */
  wait_key: string;
  timeout_at: TsOpt;
  created_at: TsDefault;
}

/** A chat user's linked GitHub account (#153); the token columns hold sealed values (util/seal.ts). */
export interface LinkedIdentitiesTable {
  workspace_id: string;
  chat: 'slack' | 'teams';
  chat_user_id: string;
  github_login: string;
  /** bigint: reads back as a string on Postgres. */
  github_user_id: ColumnType<number | string, number, number>;
  access_token: string;
  access_token_expires_at: TsOpt;
  refresh_token: Opt<string>;
  refresh_token_expires_at: TsOpt;
  linked_at: TsDefault;
  updated_at: TsDefault;
}

/** A per-user capture token (#374): its SHA-256, never the token. Not a projection. */
export interface CaptureTokensTable {
  id: string;
  workspace_id: string;
  /** The map handle of the person the token identifies. */
  person: string;
  label: Opt<string>;
  /** Lowercase hex SHA-256 of the whole token, prefix included. */
  token_hash: string;
  issued_at: TsDefault;
  last_used_at: TsOpt;
  revoked_at: TsOpt;
}

export interface Database {
  workspaces: WorkspacesTable;
  config_versions: ConfigVersionsTable;
  incident_events: IncidentEventsTable;
  incidents: IncidentsTable;
  claims: ClaimsTable;
  subscriptions: SubscriptionsTable;
  escalation_scores: EscalationScoresTable;
  artifacts: ArtifactsTable;
  webhook_inbox: WebhookInboxTable;
  outbox: OutboxTable;
  kv: KvTable;
  jobs: JobsTable;
  job_waits: JobWaitsTable;
  linked_identities: LinkedIdentitiesTable;
  bot_messages: BotMessagesTable;
  capture_tokens: CaptureTokensTable;
}

/** Every table the migration set creates, in creation order. */
export const STATE_TABLES: readonly (keyof Database)[] = Object.freeze([
  'workspaces',
  'config_versions',
  'incident_events',
  'incidents',
  'claims',
  'subscriptions',
  'escalation_scores',
  'artifacts',
  'webhook_inbox',
  'outbox',
  'kv',
  'jobs',
  'job_waits',
  'linked_identities',
  'bot_messages',
  'capture_tokens',
] as const);

// Factory ------------------------------------------------------------------------------------------

/** SQLite file used when `StateOptions.url` is absent (gitignored by `*.sqlite`). */
export const DEFAULT_SQLITE_PATH = 'snapwing.sqlite';

/** Test and tooling hooks beyond `StateOptions`. */
export interface OpenStateHooks {
  /** Application clock; default `() => new Date()`. */
  now?: () => Date;
  /**
   * Called with a Postgres idle-client error (admin shutdown, network drop). The pool drops that
   * client and the next query reconnects; the error is never rethrown. Default: ignore.
   */
  onPoolError?: (error: Error) => void;
}

function sqlitePath(url: string | undefined): string {
  if (url === undefined || url === '') {
    return DEFAULT_SQLITE_PATH;
  }
  return url.startsWith('file:') ? decodeURIComponent(new URL(url).pathname) : url;
}

function createDb(options: StateOptions, hooks: OpenStateHooks): Kysely<Database> {
  if (options.dialect === 'sqlite') {
    const database = new BetterSqlite3(sqlitePath(options.url));
    try {
      // B 2: WAL mode. An in-memory database reports `memory` and stays that way.
      database.pragma('journal_mode = WAL');
      database.pragma('synchronous = NORMAL');
      database.pragma('foreign_keys = ON');
      database.pragma('busy_timeout = 5000');
    } catch (e) {
      database.close();
      throw e;
    }
    return new Kysely<Database>({ dialect: new SqliteDialect({ database }) });
  }
  if (options.url === undefined || options.url === '') {
    throw new Error('openState: postgres needs a url (DATABASE_URL)');
  }
  const pool = new pg.Pool({ connectionString: options.url });
  // pg requires an `error` listener on every Pool: an idle client's backend error (57P01 after
  // pg_terminate_backend or a drop with FORCE, a network drop) is emitted here, and with no listener
  // it becomes an uncaught exception. Record it and carry on; the pool already discarded the client.
  pool.on('error', (error: Error) => {
    hooks.onPoolError?.(error);
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

class RootStateStore extends StateStore implements OpenedState {
  #closed = false;

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.ctx.db.destroy();
  }
}

/**
 * Opens the state store and brings its schema up to date (B 10: migrations run on open, forward
 * only, under an advisory lock on Postgres). Rejects with `StateMigrationError` naming the failed
 * migration; the handle is closed then.
 */
export const openState = async (options: StateOptions, hooks: OpenStateHooks = {}): Promise<OpenedState> => {
  const db = createDb(options, hooks);
  try {
    await migrateState(db, options.dialect);
  } catch (e) {
    await db.destroy();
    throw e;
  }
  return new RootStateStore({ db, dialect: options.dialect, codec: createCodec(options.dialect), now: hooks.now ?? (() => new Date()) });
};

// Compile-time check that the factory matches the port's declared signature.
const _signature: OpenState = openState;
void _signature;
