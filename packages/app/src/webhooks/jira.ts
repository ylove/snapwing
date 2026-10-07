// src/webhooks/jira.ts: Jira inbound sync (B 7.3, B 8) and the fixer trigger (main 10.1, main 10.4),
// as one web-standard handler (ADR 0016) for `POST /webhooks/jira` (the URL `pnpm jira:bootstrap`
// registers, #144).
//
// Per delivery, in order:
//   1. Secret. When `secret` (`JIRA_WEBHOOK_SECRET`) is set, the request carries either Jira's
//      `X-Hub-Signature: sha256=<hex HMAC-SHA256 of the body>` (a webhook created with a secret) or
//      `?secret=<secret>` in the URL (a webhook registered through the REST API, which Jira does not
//      sign). Anything else is 401, before the body is trusted for anything.
//   2. Parse. A body that is not a JSON object is 400.
//   3. Mapping. Only `jira:issue_updated` changes anything (comments with intent phrases go to the
//      signal path in phase 4, Companion A 1.2). The issue maps to an incident by `incidents.jira_key`;
//      no incident, nothing to do.
//   4. Dedupe (B 8): `seenWebhook('jira', key, 7 days)`, the key being `webhookEvent`, the issue id,
//      and the issue's `updated` timestamp (a SHA-256 of the body when a payload lacks them). For an
//      issue update this runs in the same transaction as the appends of step 5, so a delivery that
//      fails is not marked seen and Jira's retry is processed. A duplicate is 200 and does nothing.
//   5. Inbound sync (B 7.3). A change by the agent's own account (`JiraClient.myself`) is an echo of
//      its own outbox write and appends nothing. A human's priority, assignee, and status changes
//      append `jira-priority-changed`, `jira-assignee-changed`, `jira-transitioned` (source `jira`,
//      actor role `human`) and drop the agent's pending outbox write to the same field (batch key
//      `field:{incident}:{field}`, `jiraFieldBatchKey`): last human write wins.
//   6. Triggers, after the commit. A transition to the project's in-progress status (the logical
//      `in-progress` target resolved per project by `deps.statuses`, #269: a config override such as
//      `Doing`, else the category rule; the literal name `In Progress` when no resolver is wired or
//      the project's statuses cannot be read or resolved) with a non-empty `Implementation
//      Prompt` calls `startFixer` (attempt 1). This one fires on the agent's own transition too: at
//      levels 2 and 3, and at level 1 after Fix it, the engine's own In Progress transition is what
//      starts the fixer (main 10.1, engine/steps.ts `afterFiledStep`), and `startFixer` cannot echo.
//      It does not fire while a human owns the incident (`claimed`, `human-fixing`) or on a terminal
//      one; `fixer.run` refuses the rest (a stop, a run going, attempt 1 already run). A human adding
//      the `snapwing:stop` label calls `stopIncident`.
//
// Responses: 200 `{ outcome }` (`processed`, `echo`, `duplicate`, `ignored`), 400, 401; a failure is the
// server's 500 and Jira retries. The response never echoes the body or the secret.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { EventActor, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import { isExpectedSeqConflict, type IncidentView } from '@snapwing/pipeline/contracts/state.ts';
import { newEvent, startFixer, type FixerDeps } from '@snapwing/pipeline/fixer/job.ts';
import { stopIncident } from '@snapwing/pipeline/fixer/stop.ts';
import { isTerminalStatus, OWNS_ITS_KEY } from '@snapwing/pipeline/lifecycle/machine.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { jiraFieldBatchKey, type JiraField } from '@snapwing/pipeline/state/projections/outbox/jira.ts';
import type { JiraClient } from '../jira/client/client.ts';
import type { StatusResolver } from '../jira/projector/statuses.ts';

export const JIRA_WEBHOOK_PATH = '/webhooks/jira';
/** The `seenWebhook` source. */
export const JIRA_WEBHOOK_SOURCE = 'jira';
/** B 8: seven days. */
export const JIRA_WEBHOOK_TTL_SEC = 7 * 24 * 60 * 60;
export const JIRA_WEBHOOK_SECRET_NAME = 'JIRA_WEBHOOK_SECRET';
/** The label that stops the incident (main 10.4). */
export const LABEL_STOP = 'snapwing:stop';
/** The status name that starts the fixer when no resolver says otherwise (main 10.1). */
export const JIRA_IN_PROGRESS = 'In Progress';
const ISSUE_UPDATED = 'jira:issue_updated';
const MAX_APPEND_ATTEMPTS = 8;

export interface JiraWebhookDeps {
  /** The fixer's deps; its `state`, `workspaceId`, and `clock` serve this handler too. */
  fixer: FixerDeps;
  /** The account the agent's Jira credentials act as; read once and kept. */
  jira: Pick<JiraClient, 'myself'>;
  /** `JIRA_WEBHOOK_SECRET`; when absent, deliveries are not authenticated. */
  secret?: string;
  /**
   * Resolves the `in-progress` logical status to the issue's project's own status name (#269). When
   * absent, or when it rejects, the trigger compares against `In Progress`.
   */
  statuses?: Pick<StatusResolver, 'resolve'>;
  /**
   * The Jira field id of `Implementation Prompt` (`JIRA_FIELD_IMPL_PROMPT`, for example
   * `customfield_10050`). When absent the In Progress trigger leaves the check to `fixer.run`, which
   * refuses an incident whose plan has no implementation request.
   */
  implementationPromptFieldId?: string;
}

/** `echo`: the agent's own change; nothing synced (the In Progress trigger still applies). */
export type JiraWebhookOutcome = 'processed' | 'duplicate' | 'ignored' | 'echo';

/** The `POST /webhooks/jira` handler. */
export function createJiraWebhookRoute(deps: JiraWebhookDeps): (req: Request) => Promise<Response> {
  const agentAccount = memoAccount(deps.jira);
  return async (req) => {
    const raw = new Uint8Array(await req.arrayBuffer());
    if (deps.secret !== undefined && deps.secret !== '' && !authentic(req, raw, deps.secret)) {
      return json(401, { error: 'unauthorized' });
    }
    const payload = parse(raw);
    if (payload === undefined) return json(400, { error: 'invalid-json' });
    return json(200, { outcome: await handle(deps, agentAccount, payload, raw) });
  };
}

// Handling ---------------------------------------------------------------------------------------

async function handle(deps: JiraWebhookDeps, agentAccount: () => Promise<string>, payload: Payload, raw: Uint8Array): Promise<JiraWebhookOutcome> {
  const state = deps.fixer.state;
  const key = deliveryKey(payload, raw);
  const incident = payload.webhookEvent === ISSUE_UPDATED && payload.issueKey !== undefined ? await incidentFor(deps, payload.issueKey) : undefined;
  if (incident === undefined) {
    return (await state.seenWebhook(JIRA_WEBHOOK_SOURCE, key, JIRA_WEBHOOK_TTL_SEC)) ? 'duplicate' : 'ignored';
  }

  const own = payload.accountId !== undefined && payload.accountId === (await agentAccount());
  const actor: EventActor = { id: payload.accountId ?? 'jira:unknown', role: 'human' };
  const changes = own ? [] : fieldChanges(payload);
  const occurredAt = payload.timestamp ?? deps.fixer.clock().toISOString();
  const jiraKey = incident.jiraKey;
  const events = changes.map((c) => toEvent(deps, incident.id, jiraKey, c, actor, occurredAt));

  const fresh = await commitDelivery(state, key, incident.id, events, [...new Set(changes.map((c) => c.field))]);
  if (!fresh) return 'duplicate';

  const after = (await state.getIncident(incident.id)) ?? incident;
  if (!own && addedLabels(payload).includes(LABEL_STOP)) {
    await stopIncident(deps.fixer, { incidentId: incident.id, actor, source: 'jira', reason: `${LABEL_STOP} label added in Jira` });
  } else if (await movedToInProgress(deps.statuses, jiraKey, payload) && fixerMayStart(after) && promptPresent(deps, payload)) {
    await startFixer(deps.fixer, { incidentId: incident.id, attempt: 1 });
  }
  return own ? 'echo' : 'processed';
}

/**
 * In one transaction: records the delivery, appends `events`, and drops the agent's pending writes to
 * `fields`. False when the delivery was seen already (nothing written). Retries on a seq conflict.
 */
async function commitDelivery(state: StatePort, key: string, incidentId: string, events: NewEvent[], fields: JiraField[]): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await state.transaction(async (tx) => {
        if (await tx.seenWebhook(JIRA_WEBHOOK_SOURCE, key, JIRA_WEBHOOK_TTL_SEC)) return false;
        if (events.length > 0) {
          const log = await tx.read(incidentId);
          await tx.append(incidentId, events, log.at(-1)?.seq ?? 0);
        }
        // After the append, so a row the append itself implied for a field the human set goes too.
        for (const field of fields) await tx.dropOutbox('jira', jiraFieldBatchKey(incidentId, field));
        return true;
      });
    } catch (e) {
      if (!isExpectedSeqConflict(e) || attempt >= MAX_APPEND_ATTEMPTS) throw e;
    }
  }
}

async function incidentFor(deps: JiraWebhookDeps, issueKey: string): Promise<(IncidentView & { jiraKey: string }) | undefined> {
  const [found] = await deps.fixer.state.findIncidents({ workspaceId: deps.fixer.workspaceId, jiraKey: issueKey, status: OWNS_ITS_KEY, limit: 1 });
  return found?.jiraKey === undefined ? undefined : { ...found, jiraKey: found.jiraKey };
}

/** Not while a human owns the incident or after it ended; `fixer.run` refuses the rest. */
function fixerMayStart(incident: IncidentView): boolean {
  return incident.status !== 'claimed' && incident.status !== 'human-fixing' && !isTerminalStatus(incident.status);
}

function promptPresent(deps: JiraWebhookDeps, payload: Payload): boolean {
  const id = deps.implementationPromptFieldId;
  if (id === undefined || id === '') return true;
  return hasText(payload.fields[id]);
}

/** A non-blank string, or an ADF node with a non-blank text node somewhere inside. */
function hasText(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.some(hasText);
  if (isRecord(value)) return hasText(value['text']) || hasText(value['content']);
  return false;
}

// Changes ----------------------------------------------------------------------------------------

type FieldChange =
  | { field: 'priority'; from?: string; to: string }
  | { field: 'assignee'; from?: string; to?: string }
  | { field: 'status'; from: string; to: string };

/** The priority, assignee, and status changes in the changelog, in its order. */
function fieldChanges(payload: Payload): FieldChange[] {
  const out: FieldChange[] = [];
  for (const item of payload.items) {
    switch (item.field) {
      case 'priority':
        if (item.toString !== undefined) out.push({ field: 'priority', ...opt('from', item.fromString), to: item.toString });
        break;
      case 'assignee':
        out.push({ field: 'assignee', ...opt('from', item.from), ...opt('to', item.to) });
        break;
      case 'status':
        if (item.toString !== undefined) out.push({ field: 'status', from: item.fromString ?? '', to: item.toString });
        break;
      default:
        break;
    }
  }
  return out;
}

function toEvent(deps: JiraWebhookDeps, incidentId: string, jiraKey: string, change: FieldChange, actor: EventActor, occurredAt: string): NewEvent {
  const extra = { actor, source: 'jira' as const };
  const event = (() => {
    switch (change.field) {
      case 'priority':
        return newEvent(deps.fixer, incidentId, 'jira-priority-changed', { jiraKey, ...opt('from', change.from), to: change.to }, extra);
      case 'assignee':
        return newEvent(deps.fixer, incidentId, 'jira-assignee-changed', { jiraKey, ...opt('from', change.from), ...opt('to', change.to) }, extra);
      case 'status':
        return newEvent(deps.fixer, incidentId, 'jira-transitioned', { jiraKey, from: change.from, to: change.to }, extra);
    }
  })();
  return { ...event, occurredAt };
}

function movedTo(payload: Payload, status: string): boolean {
  const want = status.toLowerCase();
  return payload.items.some((i) => i.field === 'status' && i.toString?.trim().toLowerCase() === want);
}

/** The name `issueKey`'s project calls the in-progress status; `In Progress` when it cannot be resolved. */
export async function inProgressStatusName(statuses: Pick<StatusResolver, 'resolve'> | undefined, issueKey: string): Promise<string> {
  if (statuses === undefined) return JIRA_IN_PROGRESS;
  try {
    return await statuses.resolve(issueKey, 'in-progress');
  } catch {
    return JIRA_IN_PROGRESS;
  }
}

/** Whether `status` is the in-progress status of `issueKey`'s project (compared without regard to case). */
export async function isInProgressStatus(statuses: Pick<StatusResolver, 'resolve'> | undefined, issueKey: string, status: string): Promise<boolean> {
  return status.trim().toLowerCase() === (await inProgressStatusName(statuses, issueKey)).trim().toLowerCase();
}

async function movedToInProgress(statuses: Pick<StatusResolver, 'resolve'> | undefined, issueKey: string, payload: Payload): Promise<boolean> {
  // Only a delivery that changes the status needs the project's statuses read.
  if (!payload.items.some((i) => i.field === 'status' && i.toString !== undefined)) return false;
  return movedTo(payload, await inProgressStatusName(statuses, issueKey));
}

/** Labels the changelog adds (Jira sends labels as space-separated `fromString` and `toString`). */
function addedLabels(payload: Payload): string[] {
  const added: string[] = [];
  for (const item of payload.items) {
    if (item.field !== 'labels') continue;
    const before = new Set(words(item.fromString));
    for (const label of words(item.toString)) if (!before.has(label)) added.push(label);
  }
  return added;
}

function words(s: string | undefined): string[] {
  return (s ?? '').split(/\s+/).filter((w) => w !== '');
}

// Delivery ---------------------------------------------------------------------------------------

/** B 8: `webhookEvent` plus the issue's `updated` timestamp (and its id), else a SHA-256 of the body. */
function deliveryKey(payload: Payload, raw: Uint8Array): string {
  const issue = payload.issueId ?? payload.issueKey;
  if (payload.webhookEvent !== undefined && issue !== undefined && payload.updated !== undefined) {
    return `${payload.webhookEvent}:${issue}:${payload.updated}`;
  }
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

function authentic(req: Request, raw: Uint8Array, secret: string): boolean {
  const signature = req.headers.get('x-hub-signature');
  if (signature !== null) {
    const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    return safeEqual(signature.trim().toLowerCase(), expected);
  }
  const given = new URL(req.url).searchParams.get('secret');
  return given !== null && safeEqual(given, secret);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

function memoAccount(jira: Pick<JiraClient, 'myself'>): () => Promise<string> {
  let pending: Promise<string> | undefined;
  return () => {
    pending ??= jira.myself().then(
      (me) => me.accountId,
      (e: unknown) => {
        pending = undefined;
        throw e;
      },
    );
    return pending;
  };
}

// Parsing (the body is untrusted; unknown keys are ignored) --------------------------------------

interface ChangeItem {
  /** `fieldId` when Jira sends it, else `field`, lower-cased. */
  field: string;
  from?: string;
  fromString?: string;
  to?: string;
  toString?: string;
}

interface Payload {
  webhookEvent?: string;
  /** ISO 8601, from the epoch-millisecond `timestamp`. */
  timestamp?: string;
  accountId?: string;
  issueId?: string;
  issueKey?: string;
  updated?: string;
  fields: Record<string, unknown>;
  items: ChangeItem[];
}

function parse(raw: Uint8Array): Payload | undefined {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return undefined;
  }
  if (!isRecord(body)) return undefined;
  const issue = isRecord(body['issue']) ? body['issue'] : {};
  const fields = isRecord(issue['fields']) ? issue['fields'] : {};
  const user = isRecord(body['user']) ? body['user'] : {};
  const changelog = isRecord(body['changelog']) ? body['changelog'] : {};
  const items = Array.isArray(changelog['items']) ? changelog['items'].filter(isRecord).map(toItem) : [];
  const ts = body['timestamp'];
  const timestamp = typeof ts === 'number' && Number.isFinite(ts) ? new Date(ts) : undefined;
  return {
    ...opt('webhookEvent', str(body, 'webhookEvent')),
    ...opt('timestamp', timestamp !== undefined && !Number.isNaN(timestamp.getTime()) ? timestamp.toISOString() : undefined),
    ...opt('accountId', str(user, 'accountId')),
    ...opt('issueId', str(issue, 'id')),
    ...opt('issueKey', str(issue, 'key')),
    ...opt('updated', str(fields, 'updated')),
    fields,
    items,
  };
}

function toItem(item: Record<string, unknown>): ChangeItem {
  return {
    field: (str(item, 'fieldId') ?? str(item, 'field') ?? '').toLowerCase(),
    ...opt('from', str(item, 'from')),
    ...opt('fromString', str(item, 'fromString')),
    ...opt('to', str(item, 'to')),
    ...opt('toString', str(item, 'toString')),
  };
}

/** An own string property (never an inherited one: `toString` is a changelog key). */
function str(o: Record<string, unknown>, k: string): string | undefined {
  if (!Object.hasOwn(o, k)) return undefined;
  const v = o[k];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function opt<K extends string>(k: K, v: string | undefined): { [P in K]?: string } {
  return (v === undefined ? {} : { [k]: v }) as { [P in K]?: string };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
