// 0001: every B 3 table and index, plus the scheduler's `jobs` (B 3, last paragraph) and
// `job_waits` (ADR 0012). Column types, defaults, and dialect checks come from schema.ts (ADR 0011).
// Deviations from B 3, both from ADR 0011: index names are explicit (`{table}_{columns}_idx`), and
// `subscriptions.scope_id` is not null with '' for scope `all`.

import type { Kysely } from 'kysely';
import type { StateDialect } from '../../contracts/state.ts';
import { createIndex, createTable } from './schema.ts';

export const name = '0001-initial';

export async function up(db: Kysely<unknown>, dialect: StateDialect): Promise<void> {
  // Tenancy and config ---------------------------------------------------------------------------

  await createTable(db, dialect, 'workspaces', {
    columns: {
      id: { type: 'text', primaryKey: true },
      slug: { type: 'text', notNull: true, unique: true },
      created_at: { type: 'timestamptz', notNull: true, default: 'now' },
    },
  });

  await createTable(db, dialect, 'config_versions', {
    columns: {
      workspace_id: { type: 'text', notNull: true, references: 'workspaces.id' },
      kind: { type: 'text', notNull: true, check: "kind in ('map', 'playbook', 'instructions')" },
      hash: { type: 'text', notNull: true },
      body: { type: 'text', notNull: true },
      valid: { type: 'boolean', notNull: true },
      errors: { type: 'jsonb' },
      loaded_at: { type: 'timestamptz', notNull: true, default: 'now' },
    },
    primaryKey: ['workspace_id', 'kind', 'hash'],
  });

  // Event log (the truth) ------------------------------------------------------------------------

  await createTable(db, dialect, 'incident_events', {
    columns: {
      workspace_id: { type: 'text', notNull: true },
      incident_id: { type: 'text', notNull: true },
      seq: { type: 'integer', notNull: true },
      type: { type: 'text', notNull: true },
      v: { type: 'smallint', notNull: true, default: 1 },
      source: { type: 'text', notNull: true },
      actor_id: { type: 'text' },
      actor_role: { type: 'text' },
      payload: { type: 'jsonb', notNull: true },
      occurred_at: { type: 'timestamptz', notNull: true },
      recorded_at: { type: 'timestamptz', notNull: true, default: 'now' },
    },
    primaryKey: ['incident_id', 'seq'],
  });
  await createIndex(db, 'incident_events', ['workspace_id', 'recorded_at']);
  await createIndex(db, 'incident_events', ['type', 'recorded_at']);

  // Projections (rebuildable) --------------------------------------------------------------------

  await createTable(db, dialect, 'incidents', {
    columns: {
      id: { type: 'text', primaryKey: true },
      workspace_id: { type: 'text', notNull: true },
      parent_id: { type: 'text', references: 'incidents.id' },
      kind: { type: 'text', notNull: true, check: "kind in ('incident', 'work-item')" },
      last_seq: { type: 'integer', notNull: true, default: 0 },
      status: { type: 'text', notNull: true },
      surface_id: { type: 'text' },
      component_id: { type: 'text' },
      repo: { type: 'text' },
      jira_key: { type: 'text' },
      pr_number: { type: 'integer' },
      branch: { type: 'text' },
      priority: { type: 'text' },
      autonomy_level: { type: 'smallint' },
      assignee_id: { type: 'text' },
      reporter_id: { type: 'text' },
      source: { type: 'text', notNull: true },
      channel_id: { type: 'text' },
      anchor_id: { type: 'text' },
      status_msg_id: { type: 'text' },
      summary: { type: 'text' },
      waiting_on: { type: 'jsonb' },
      monitored: { type: 'boolean', notNull: true, default: false },
      opened_at: { type: 'timestamptz', notNull: true },
      closed_at: { type: 'timestamptz' },
      updated_at: { type: 'timestamptz', notNull: true },
    },
  });
  await createIndex(db, 'incidents', ['workspace_id', 'status']);
  await createIndex(db, 'incidents', ['workspace_id', 'surface_id', 'status']);
  await createIndex(db, 'incidents', ['jira_key']);

  await createTable(db, dialect, 'claims', {
    columns: {
      incident_id: { type: 'text', notNull: true, references: 'incidents.id' },
      claimer_id: { type: 'text', notNull: true },
      since: { type: 'timestamptz', notNull: true },
      last_activity: { type: 'timestamptz', notNull: true },
      expires_at: { type: 'timestamptz', notNull: true },
      hold_env: { type: 'text' },
      hold_expires_at: { type: 'timestamptz' },
    },
    primaryKey: ['incident_id', 'claimer_id'],
  });

  await createTable(db, dialect, 'subscriptions', {
    columns: {
      workspace_id: { type: 'text', notNull: true },
      user_id: { type: 'text', notNull: true },
      scope_kind: { type: 'text', notNull: true, check: "scope_kind in ('incident', 'surface', 'all')" },
      // Not null, '' for scope `all`: a primary key column cannot be null on Postgres (ADR 0011).
      scope_id: { type: 'text', notNull: true },
      channel: { type: 'text', notNull: true, check: "channel in ('thread', 'dm')" },
      created_at: { type: 'timestamptz', notNull: true, default: 'now' },
    },
    primaryKey: ['workspace_id', 'user_id', 'scope_kind', 'scope_id'],
  });

  await createTable(db, dialect, 'escalation_scores', {
    columns: {
      incident_id: { type: 'text', notNull: true, references: 'incidents.id' },
      intent: { type: 'text', notNull: true },
      reactor_ids: { type: 'jsonb', notNull: true },
      score: { type: 'numeric', notNull: true },
      step_reached: { type: 'smallint' },
      window_ends: { type: 'timestamptz', notNull: true },
    },
    primaryKey: ['incident_id', 'intent'],
  });

  // Artifacts ------------------------------------------------------------------------------------

  await createTable(db, dialect, 'artifacts', {
    columns: {
      id: { type: 'text', notNull: true },
      version: { type: 'integer', notNull: true },
      workspace_id: { type: 'text', notNull: true },
      incident_id: { type: 'text', notNull: true },
      kind: { type: 'text', notNull: true },
      content_type: { type: 'text', notNull: true },
      sha256: { type: 'text', notNull: true },
      body: { type: 'text', notNull: true },
      created_by: { type: 'text', notNull: true },
      created_at: { type: 'timestamptz', notNull: true, default: 'now' },
    },
    primaryKey: ['id', 'version'],
  });

  // Inbox / outbox -------------------------------------------------------------------------------

  await createTable(db, dialect, 'webhook_inbox', {
    columns: {
      source: { type: 'text', notNull: true },
      delivery_id: { type: 'text', notNull: true },
      received_at: { type: 'timestamptz', notNull: true, default: 'now' },
      expires_at: { type: 'timestamptz', notNull: true },
    },
    primaryKey: ['source', 'delivery_id'],
  });

  await createTable(db, dialect, 'outbox', {
    columns: {
      id: { type: 'text', primaryKey: true },
      workspace_id: { type: 'text', notNull: true },
      target: { type: 'text', notNull: true },
      incident_id: { type: 'text' },
      op: { type: 'text', notNull: true },
      payload: { type: 'jsonb', notNull: true },
      batch_key: { type: 'text' },
      attempts: { type: 'smallint', notNull: true, default: 0 },
      next_attempt: { type: 'timestamptz', notNull: true, default: 'now' },
      last_error: { type: 'text' },
      created_at: { type: 'timestamptz', notNull: true, default: 'now' },
      done_at: { type: 'timestamptz' },
    },
  });
  await createIndex(db, 'outbox', ['target', 'done_at', 'next_attempt']);

  // Cache-port fallback (used when Redis is absent) ----------------------------------------------

  await createTable(db, dialect, 'kv', {
    columns: {
      k: { type: 'text', primaryKey: true },
      v: { type: 'text', notNull: true },
      expires_at: { type: 'timestamptz' },
    },
  });

  // Workflow -------------------------------------------------------------------------------------

  // The in-process scheduler's job store (B 3, last paragraph: the columns pg-boss exposes, plus
  // what retries, park, and resume need). pg-boss keeps its own tables on Postgres; this one is
  // created on both dialects so the schema is identical.
  await createTable(db, dialect, 'jobs', {
    columns: {
      id: { type: 'text', primaryKey: true },
      name: { type: 'text', notNull: true },
      data: { type: 'jsonb', notNull: true },
      state: {
        type: 'text',
        notNull: true,
        check: "state in ('created', 'retry', 'active', 'parked', 'completed', 'cancelled', 'failed')",
      },
      start_after: { type: 'timestamptz', notNull: true },
      singleton_key: { type: 'text' },
      retry_count: { type: 'integer', notNull: true, default: 0 },
      retry_limit: { type: 'integer', notNull: true, default: 0 },
      retry_backoff: { type: 'boolean', notNull: true, default: false },
      /** The ADR 0012 `job.resumed` payload for the next delivery. */
      resumed: { type: 'jsonb' },
      /** The last failure's message. */
      last_error: { type: 'text' },
      created_at: { type: 'timestamptz', notNull: true, default: 'now' },
      started_at: { type: 'timestamptz' },
      completed_at: { type: 'timestamptz' },
    },
  });
  await createIndex(db, 'jobs', ['name', 'state', 'start_after']);
  await createIndex(db, 'jobs', ['singleton_key']);

  // One row per parked job (ADR 0012); resume looks rows up by (wait_kind, wait_key).
  await createTable(db, dialect, 'job_waits', {
    columns: {
      job_id: { type: 'text', primaryKey: true },
      wait_kind: { type: 'text', notNull: true },
      wait_key: { type: 'text', notNull: true },
      timeout_at: { type: 'timestamptz' },
      created_at: { type: 'timestamptz', notNull: true, default: 'now' },
    },
  });
  await createIndex(db, 'job_waits', ['wait_kind', 'wait_key']);
  await createIndex(db, 'job_waits', ['timeout_at']);
}
