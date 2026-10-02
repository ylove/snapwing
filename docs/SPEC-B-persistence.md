# Snapwing Companion Spec B: Persistence, Workflow, and Coordination

**Status:** Living Document, Companion B v1.1
**Changelog:** vB1.1 (2026-10-01): renamed to Snapwing; decisions from the decisions section applied (the ModelPort and HarnessPort join the ports below; see main spec 14.5). vB1.0: first version.
**Read after:** the main spec (v1.5) and Companion A (v1.1). This document defines where state lives, how long-running work survives restarts, how several agents work on one incident without talking to each other, and how Jira is kept in sync without becoming the database.

---

## 0. Principles

1. **The event log is the truth.** Every fact about an incident is an event in an append-only log. Everything else (current status, claims, scores, what Jira shows) is a projection that can be rebuilt from the log.
2. **Jira is a view, not a store.** One projector writes to Jira from an outbox. Agents never read pipeline state from Jira. Human edits in Jira arrive as events like any other input.
3. **Agents do not talk to each other.** They write typed events and read the log through the state port. Coordination is a step in the workflow, not a conversation in comments.
4. **Fixers never touch the database.** They report through the server's API with a scoped token. The database stays inside one trust boundary and the runner port stays provider-agnostic.
5. **Every timer is durable.** Parked jobs, claim expiries, environment holds, stall detection, heartbeats, revert windows: all are rows, not `setTimeout`.
6. **Provider-agnostic, one schema.** SQLite on the local provider, Postgres everywhere else, one migration set through a query builder that targets both.

---

## 1. Ports

Two ports join the five in the main spec (queue, cache, secrets, object store, runner). The ModelPort and HarnessPort (main spec 14.5) complete the set.

```typescript
// src/ports/state.ts

export interface StatePort {
  // Event log
  append(incidentId: string, events: NewEvent[], expectedSeq?: number): Promise<{ seq: number }>;
  read(incidentId: string, fromSeq?: number): Promise<IncidentEvent[]>;
  readSince(cursor: string, limit: number): Promise<{ events: IncidentEvent[]; cursor: string }>;

  // Projections (derived, rebuildable)
  getIncident(incidentId: string): Promise<IncidentView | null>;
  findIncidents(q: IncidentQuery): Promise<IncidentView[]>;          // by surface, status, key, text
  getClaims(incidentId: string): Promise<Claim[]>;
  getSubscriptions(incidentId: string): Promise<Subscription[]>;

  // Artifacts (versioned, content-addressed)
  putArtifact(a: NewArtifact): Promise<{ id: string; version: number }>;
  getArtifact(id: string, version?: number): Promise<Artifact>;

  // Inbox / outbox
  seenWebhook(source: string, deliveryId: string, ttlSec: number): Promise<boolean>;   // true if already seen
  enqueueOutbox(item: OutboxItem): Promise<void>;
  drainOutbox(target: 'jira' | 'github' | 'slack' | 'teams', limit: number): Promise<OutboxItem[]>;
  ackOutbox(ids: string[]): Promise<void>;

  // Config cache
  putConfigVersion(kind: 'map' | 'playbook' | 'instructions', hash: string, body: string): Promise<void>;
  getConfigVersion(kind: 'map' | 'playbook' | 'instructions'): Promise<{ hash: string; body: string }>;

  transaction<T>(fn: (tx: StatePort) => Promise<T>): Promise<T>;
}
```

```typescript
// src/ports/workflow.ts

export interface WorkflowPort {
  // Durable jobs
  start(name: JobName, input: unknown, opts: { singletonKey?: string; retryLimit?: number; retryBackoff?: boolean }): Promise<{ jobId: string }>;
  schedule(name: JobName, input: unknown, runAt: Date, opts?: { singletonKey?: string }): Promise<{ jobId: string }>;
  cancel(singletonKey: string): Promise<void>;
  work(name: JobName, handler: (job: Job) => Promise<void>, opts?: { concurrency?: number }): void;

  // Parking and resuming (awaitInteractive, waiting on children, waiting on CI)
  park(jobId: string, waitingOn: WaitKey, timeoutAt?: Date): Promise<void>;
  resume(waitingOn: WaitKey, result: unknown): Promise<{ resumed: number }>;

  // Recurring
  cron(name: JobName, expression: string, input?: unknown): Promise<void>;
}

export type WaitKey = { kind: 'tap'; eventId: string } | { kind: 'children'; parentId: string }
                    | { kind: 'ci'; prId: string } | { kind: 'deploy'; env: string; sha: string }
                    | { kind: 'verification'; incidentId: string };
```

The cache port becomes optional: on small installs, idempotency keys and rate limits live in the database. On the cloud providers Redis remains as the faster option and nothing else changes.

---

## 2. Provider matrix

| Provider | State | Workflow | Notes |
|---|---|---|---|
| `local` (dev, demo) | SQLite via `better-sqlite3`, WAL mode | In-process scheduler over the same SQLite file | Single writer; fine for one node. Optional `litestream` replication for anyone who runs it for real |
| `docker` | Postgres container | pg-boss in the same database | The self-host default |
| `aws` | RDS Postgres or Aurora | pg-boss | |
| `gcp` | Cloud SQL Postgres | pg-boss | |
| hosted (later) | Postgres | Temporal (or Inngest, Restate) behind `WorkflowPort` | The seam for durable execution at scale; nothing above the port changes |

pg-boss is chosen because it gives delayed jobs, retries with backoff, singleton keys, and cron inside Postgres, so a job and the events it emits commit in one transaction. It is not required; the port is. Both providers share one schema through Kysely (ADR 0011) with a migration set that runs on both dialects; the CI matrix runs the unit and contract tiers against both.

---

## 3. Schema

Every table carries `workspace_id` for multi-tenancy from day one, even though self-hosters have exactly one. Postgres installs may enable row-level security on it.

```sql
-- Tenancy and config ---------------------------------------------------------

create table workspaces (
  id            text primary key,           -- ULID
  slug          text unique not null,
  created_at    timestamptz not null default now()
);

create table config_versions (
  workspace_id  text not null references workspaces(id),
  kind          text not null check (kind in ('map','playbook','instructions')),
  hash          text not null,
  body          text not null,
  valid         boolean not null,
  errors        jsonb,
  loaded_at     timestamptz not null default now(),
  primary key (workspace_id, kind, hash)
);

-- Event log (the truth) ------------------------------------------------------

create table incident_events (
  workspace_id  text not null,
  incident_id   text not null,
  seq           integer not null,           -- per-incident, gapless
  type          text not null,              -- Companion A 4.2 names, plus coordination events (section 6)
  v             smallint not null default 1,-- event schema version
  source        text not null,              -- slack|teams|jira|github|ci|deploy|agent|cli|fixer
  actor_id      text,
  actor_role    text,
  payload       jsonb not null,
  occurred_at   timestamptz not null,
  recorded_at   timestamptz not null default now(),
  primary key (incident_id, seq)
);
create index on incident_events (workspace_id, recorded_at);
create index on incident_events (type, recorded_at);

-- Projections (rebuildable) --------------------------------------------------

create table incidents (
  id              text primary key,
  workspace_id    text not null,
  parent_id       text references incidents(id),   -- set on child work items (section 6)
  kind            text not null check (kind in ('incident','work-item')),
  last_seq        integer not null default 0,
  status          text not null,                   -- lifecycle state (section 5)
  surface_id      text,
  component_id    text,
  repo            text,
  jira_key        text,
  pr_number       integer,
  branch          text,
  priority        text,
  autonomy_level  smallint,
  assignee_id     text,
  reporter_id     text,
  source          text not null,                   -- slack|teams|raycast|cli|alert_webhook
  channel_id      text,
  anchor_id       text,
  status_msg_id   text,                            -- the pinned status message
  summary         text,
  waiting_on      jsonb,                           -- {kind, who, since}
  monitored       boolean not null default false,
  opened_at       timestamptz not null,
  closed_at       timestamptz,
  updated_at      timestamptz not null
);
create index on incidents (workspace_id, status);
create index on incidents (workspace_id, surface_id, status);
create index on incidents (jira_key);

create table claims (
  incident_id     text not null references incidents(id),
  claimer_id      text not null,
  since           timestamptz not null,
  last_activity   timestamptz not null,
  expires_at      timestamptz not null,
  hold_env        text,
  hold_expires_at timestamptz,
  primary key (incident_id, claimer_id)
);

create table subscriptions (
  workspace_id  text not null,
  user_id       text not null,
  scope_kind    text not null check (scope_kind in ('incident','surface','all')),
  scope_id      text,
  channel       text not null check (channel in ('thread','dm')),
  created_at    timestamptz not null default now(),
  primary key (workspace_id, user_id, scope_kind, scope_id)
);

create table escalation_scores (
  incident_id   text not null references incidents(id),
  intent        text not null,
  reactor_ids   jsonb not null,             -- unique reactors, for the ladder math
  score         numeric not null,
  step_reached  smallint,
  window_ends   timestamptz not null,
  primary key (incident_id, intent)
);

-- Artifacts (implementation requests, diagnoses, contracts between work items)

create table artifacts (
  id            text not null,
  version       integer not null,
  workspace_id  text not null,
  incident_id   text not null,
  kind          text not null,              -- implementation-request|diagnosis|contract|review|bundle
  content_type  text not null,              -- application/xml|application/json
  sha256        text not null,
  body          text not null,
  created_by    text not null,              -- agent name or user id
  created_at    timestamptz not null default now(),
  primary key (id, version)
);

-- Inbox / outbox --------------------------------------------------------------

create table webhook_inbox (
  source        text not null,              -- slack|teams|jira|github|ci|alert
  delivery_id   text not null,              -- provider's id, or a hash of the body when there is none
  received_at   timestamptz not null default now(),
  expires_at    timestamptz not null,
  primary key (source, delivery_id)
);

create table outbox (
  id            text primary key,
  workspace_id  text not null,
  target        text not null,              -- jira|github|slack|teams
  incident_id   text,
  op            text not null,              -- create-issue|update-fields|add-comment|transition|edit-message|...
  payload       jsonb not null,
  batch_key     text,                       -- comments with the same key within 60 s are merged
  attempts      smallint not null default 0,
  next_attempt  timestamptz not null default now(),
  last_error    text,
  created_at    timestamptz not null default now(),
  done_at       timestamptz
);
create index on outbox (target, done_at, next_attempt);

-- Cache-port fallback (used when Redis is absent) ------------------------------

create table kv (
  k             text primary key,
  v             text not null,
  expires_at    timestamptz
);
```

pg-boss creates its own tables (`pgboss.job`, `pgboss.archive`) in the same database. On SQLite the in-process scheduler uses a `jobs` table with the same columns pg-boss exposes (`name`, `data`, `state`, `start_after`, `singleton_key`, `retry_count`).

---

## 4. Event sourcing rules

**Append with optimistic concurrency.** `append(incidentId, events, expectedSeq)` fails if `last_seq != expectedSeq`. A worker that loses the race re-reads and decides again. This is the only lock the system needs for a single incident, and it is what makes two agents finishing at once safe.

**Projections update in the same transaction as the append.** The `incidents` row, `claims`, `escalation_scores`, and the outbox entries for a given event are written together, so a crash between "event recorded" and "Jira told" cannot happen; the outbox row exists or the event does not.

**Rebuild is a command.** `<cli> state rebuild [incidentId|--all]` truncates projections and replays the log. It runs in CI against the demo recordings so projection drift is caught before release.

**Event versioning.** Each event carries `v`. Readers upcast old versions in one place (`src/state/upcast.ts`). Events are never edited or deleted; corrections are new events (`corrected` with a reference to the seq it corrects).

**Retention.** Events are kept indefinitely (they are small). `payload.rawPayloadSnapshot` is redacted from events older than the retention window (default 30 days) by a nightly job, leaving the structured fields. Screenshots live in the object store with the same window, and on the Jira issue permanently.

---

## 5. Lifecycle state machine

`incidents.status` is derived from the last state-changing event. States and the events that move them:

```
captured ──context-assembled──► assembling ──resolved──► resolved ──dedupe-checked──► deduped
   │                                                                                     │
   │ resolution-signal                                    linked-to-existing ◄───────────┤
   ▼                                                                                     ▼
 not-filed                                                                       (clarify?) ──planned──► planned
                                                                                                          │
                                                        ┌──── claimed ◄───── filed ◄──── filed ───────────┘
                                                        │        │
                                                        │   released / let-agent-take
                                                        ▼        ▼
                                                 human-fixing   fixing ──pr-opened──► in-review ──review-passed──► ci
                                                        │                                  │                        │
                                                        │                             review-failed            ci-red
                                                        │                                  ▼                        ▼
                                                        │                             fixing (retry once)      fixing (retry once)
                                                        │                                                           │
                                                        └──pr-opened (human)──► in-review                    ci-green
                                                                                                                    ▼
                                                                                                             mergeable ──merged──► merged
                                                                                                                 │                   │
                                                                                                            held (gate)         deployed:staging
                                                                                                                                     │
                                                                                                                              verified? ──► deployed:production ──► closed
 at any state: stopped, escalated, level-changed, held:<env>, reverted (after merged)
```

Terminal states: `closed`, `not-filed`, `not-a-bug`, `linked-to-existing`. `stopped` is not terminal; it returns to `filed`.

**`awaitInteractive` in practice.** The orchestrator job calls `park(jobId, {kind:'tap', eventId}, timeoutAt)`. The button handler records the tap as an event and calls `resume({kind:'tap', eventId}, choice)`. If the timeout fires first, the scheduler resumes the job with `{ timedOut: true }` and the orchestrator applies the default (ticket-only at level 1). Parked jobs survive restarts because they are rows.

**Durable timers,** all scheduled through `WorkflowPort.schedule` with a `singletonKey` so rescheduling replaces rather than duplicates:

| Timer | Key | Default | On fire |
|---|---|---|---|
| Interactive timeout | `tap:{eventId}` | 24 h | Apply default choice |
| Claim expiry nudge | `claim-nudge:{incident}:{user}` | 2 h | Ask "still on it?" |
| Claim expiry | `claim:{incident}:{user}` | 4 h + 1 h | Release, restore autonomy level |
| Environment hold nudge / expiry | `hold:{incident}:{env}` | 1 h / 2 h | Nudge, then release the hold |
| Stall detection | `stall:{incident}` | 15 min, reset on every event | Start the `stalled-fix` ladder |
| Heartbeat (monitored only) | `heartbeat:{incident}` | 10 min | Post progress |
| Escalation ladder steps | `escalate:{incident}:{step}` | per playbook | Mention, page, or post |
| Revert window | `revert:{incident}` | 72 h | Remove the Revert button |
| Fixer budget | `fixer-budget:{incident}` | 30 min | Cancel the run, mark `fixer-failed` |

---

## 6. Multi-repo coordination

### 6.1 Shape

A fix that spans repositories is a **parent incident** with one **work item** per repository (`incidents.kind = 'work-item'`, `parent_id` set). Each work item has its own implementation request, its own fixer job, its own PR, and its own review. The parent owns the autonomy decision, the merge order, and the status message; children never post to chat.

The triage stage decides whether a fix is multi-repo. Signals: the scout finds the root cause in a shared package that other surfaces consume; the diagnosis names files in more than one repo in the map; the reporter's evidence spans surfaces. When in doubt, triage proposes it on the Fix Preview Card ("This touches `shared-ui` and `web`. Fix both? **[Both]** **[Just web]**").

### 6.2 The parent request

```xml
<implementation-request xmlns="urn:snapwing:impl:v1" issue="WEB-1042" kind="parent">
  <intent>…</intent>
  <workItems>
    <workItem id="wi-1" repo="github.com/acme/shared-ui" issue="WEB-1043">
      <scope>src/price/format.ts</scope>
      <produces contract="c-price-format-v2" />
    </workItem>
    <workItem id="wi-2" repo="github.com/acme/web" issue="WEB-1044" dependsOn="wi-1">
      <scope>src/cart/**</scope>
      <consumes contract="c-price-format-v2" />
    </workItem>
  </workItems>
  <mergeOrder>wi-1 wi-2</mergeOrder>
  <handoff mode="review" autonomy="2" allOrNothing="true" />
</implementation-request>
```

A **contract** is a versioned artifact (`artifacts.kind = 'contract'`) describing what the producing work item will expose and the consuming one may rely on: a function signature, a field name, a payload shape. It is written by the scout during triage, referenced by ID, and revised by the producing fixer if reality differs, which emits a `contract-revised` event that re-enqueues dependent fixers with the new version. This is the only channel through which one agent's work reaches another's, and it is data, not prose.

### 6.3 Coordinator algorithm

The coordinator is a job (`coordinate:{parentId}`), not a service. It is deterministic given the log.

1. **Fan-out.** For each work item with no unmet `dependsOn`, start a fixer job (singleton key `fixer:{workItemId}`). Dependent work items start when every dependency has emitted `pr-opened` and its contract is at a settled version. Emit `fanout` with the set.
2. **Park** on `{kind:'children', parentId}`. Each child's terminal-for-this-phase event (`ci-green`, `review-failed` twice, `fixer-failed`, `stopped`) calls `resume` for the parent.
3. **Fan-in.** When every child is `mergeable`, the parent evaluates one merge gate for the whole set (main spec 11.3): all review verdicts, all CI, the risk gate summed across children, no stop anywhere, level unchanged. `allOrNothing="true"` means one failing child degrades the whole set to human handling; no partial merge.
4. **Merge in order.** Walk `mergeOrder`. After each merge, wait for the dependent repo's CI to re-run against the merged dependency (a `{kind:'ci'}` park) before merging the next. A red CI here stops the walk, leaves already-merged children merged, opens a revert PR for them, and degrades the parent.
5. **Close.** When the last child is merged and deployed, the parent transitions and the status message reports the set: "Fixed across shared-ui (#212) and web (#418)."

Partial failure is expected and has one rule: the parent's status message and Jira issue always say exactly which children are in which state, and nothing is merged silently.

### 6.4 Jira shape

Parent issue plus one linked issue per work item (issue link type "is implemented by", or subtasks if the workspace prefers; onboarding asks once). The parent carries the parent request in its custom field and a rollup line in `Agent Status`. Children carry their own requests. All of it is projected from the store by the single projector; nothing in the coordinator calls Jira directly.

---

## 7. The Jira projection

### 7.1 One writer, one outbox

Every Jira write is an `outbox` row with `target='jira'`. A single projector worker per workspace drains it in order, which gives:

- **No races.** Two agents cannot update the same issue at once because no agent updates issues.
- **Batching.** Rows sharing a `batch_key` (`comment:{incident}`) that arrive within 60 seconds become one comment. Companion A's attribution comments rely on this.
- **Backpressure.** Jira rate limits (HTTP 429 with `Retry-After`) pause the drain; nothing is lost and nothing upstream notices.
- **Replay.** A wiped Jira project can be repopulated by re-emitting outbox rows from the log (`<cli> jira reproject`).

Slack and Teams edits to the pinned status message go through the same outbox with their own targets, for the same reasons.

### 7.2 Field map

| Jira field | Source | Written when |
|---|---|---|
| Summary, Description (ADF) | `planned` event | Create, and on `scope-changed` |
| Priority | `escalated` and human edits | Every change; human edits win (7.3) |
| Assignee | `claimed`, `planned`, human edits | Every change; human edits win |
| Components, Labels | resolution, intents | Create; labels appended on `human-claimed`, `needs-clarification`, `fixer-failed`, `prompt-failed`, `ux-friction` |
| Status (workflow transition) | lifecycle | `filed`→Backlog or In Progress; `merged`→In Review or Done per level; `closed`→Done; `stopped`→Backlog |
| `Implementation Prompt` (custom, text) | artifact `implementation-request` | On `planned`, and on every new artifact version |
| `Conversation Link` (custom, URL) | anchor deep link | Create |
| `Autonomy Level` (custom, number) | policy | Create, and on `level-changed` |
| `Agent Status` (custom, short text) | projection | Every state change; one line, JQL-filterable: `fixing · PR #418 · CI running · waiting on ci` |
| Comments | attribution events, diagnosis, verification, stop, degradation | Batched per 7.1 |
| Attachments | screenshots, recordings summary | Create |

### 7.3 Inbound sync

Jira webhooks (`jira:issue_updated`, `comment_created`) are deduped through `webhook_inbox`, then converted to events:

- Priority, assignee, status changed by a human → `jira-priority-changed`, `jira-assignee-changed`, `jira-transitioned` with `actor_role = 'human'`. Projections take the human's value. If the agent's own outbox has a pending write for the same field, that write is dropped: **last human write wins**, always.
- A comment from a human containing a recognized intent phrase ("stop", "on it") → the same `SignalEvent` path as chat (Companion A 1.2), with `platform: 'jira'`.
- Changes made by the agent's own account are recognized by account ID and ignored, which is what prevents echo loops.

---

## 8. Webhooks and idempotency

Every inbound webhook, from every source, passes through `seenWebhook(source, deliveryId, ttl)` before any processing. Providers that send a delivery ID (GitHub `X-GitHub-Delivery`, Slack `X-Slack-Request-Timestamp` plus event id, Jira `webhookEvent` plus issue `updated` timestamp) use it; providers that do not get a SHA-256 of the body. TTL is 7 days. A duplicate is acknowledged with 200 and dropped.

Missed webhooks are covered by two mechanisms: active monitoring (Companion A 4.5) polls for critical incidents, and a low-frequency reconciler (`reconcile`, cron every 15 minutes) compares `incidents.waiting_on` older than 30 minutes against the source of truth (the PR's check status, the issue's current status) and emits the missing event if the world moved on without telling us.

---

## 9. Fixer reporting

The fixer container receives a short-lived token scoped to one work item. It reports through four endpoints on the server and nothing else:

```
POST /fixer/{workItemId}/checkpoint   { phase: 'cloned'|'branched'|'implemented'|'tested'|'pushed'|'pr-opened', detail }
POST /fixer/{workItemId}/artifact     { kind: 'diagnosis'|'contract', body }          → versioned artifact
POST /fixer/{workItemId}/done         { prNumber, branch, summary, testsAdded }
POST /fixer/{workItemId}/failed       { reason, partialBranch?, attempts }
GET  /fixer/{workItemId}/stop         → 204 if a stop is pending; the fixer polls this between phases
```

Each call becomes an event. The checkpoint calls are what make "the fixer started 4 minutes ago and is on `fix/WEB-1042`" (Companion A 2.2) a fact rather than a guess, and the stop poll is the checkpoint mechanism from the main spec 10.4.

---

## 10. Operations

- **Backups.** Postgres: point-in-time recovery on the managed services; `pg_dump` nightly on Docker. SQLite: `litestream` to the object store if configured, otherwise a nightly copy.
- **Migrations.** Kysely migrations (ADR 0011), run on startup with an advisory lock so two API instances do not race. Migrations are forward-only; a failed migration halts startup with the reason.
- **Observability of the store itself.** Outbox depth per target, oldest undrained row age, parked-job count, timer lag (scheduled vs fired), reconciler corrections per hour. Exposed at `/metrics` (Prometheus format) and summarized in the console.
- **Size.** An incident is a few dozen events and a handful of artifacts; a busy workspace at 500 incidents a month is under 50 MB a year in Postgres. SQLite handles a single team indefinitely.

---

## 11. Test additions

| Tier | Scenario | Asserts |
|---|---|---|
| unit | Two appends with the same `expectedSeq` → one succeeds, one fails with a conflict | Optimistic concurrency |
| unit | Rebuild from the demo log reproduces identical `incidents`, `claims`, `escalation_scores` rows | Projection determinism |
| unit | Coordinator with wi-2 depending on wi-1: wi-2 does not start until wi-1 emits `pr-opened` with a settled contract | Fan-out ordering |
| unit | `allOrNothing`: one child `fixer-failed` → parent degrades, no merge job scheduled | Fan-in gate |
| contract | Jira 429 with `Retry-After: 30` → drain pauses 30 s, row not marked failed | Backpressure |
| contract | Human sets priority in Jira while an `escalated` outbox row is pending → agent write dropped, human value projected | Last human write wins |
| contract | Same GitHub delivery ID twice → second is a no-op | Inbox dedupe |
| live | Kill the worker mid-`awaitInteractive`, restart, tap the button → job resumes and files the ticket | Durable park |
| live | Suppress the CI webhook; reconciler emits `ci-green` within 15 minutes | Reconciliation |
| e2e | Multi-repo fixture (shared-ui + web): two PRs, merged in order, second CI re-run waited on, parent status reports both | Coordination end to end |
| matrix | Unit and contract tiers pass on both SQLite and Postgres | Dialect parity |

---

## 12. Open items

- **Temporal adapter** for `WorkflowPort`, with a migration path for parked jobs.
- **Snapshotting** of long incident logs (unnecessary below a few thousand events per incident; specified when it is).
- **Cross-workspace dedupe** for the hosted offering (the same open-source dependency bug hitting many tenants).
- **Read replicas** for the status-query path if it ever contends with writers.
- **Export.** A workspace should be able to leave with its whole log as JSONL plus artifacts; specify the format.
