// The Jira projector (B 7.1): the one writer to Jira for a workspace. It drains `target='jira'`
// outbox rows in order, validates each before sending (ops.ts), and then acks, holds, defers, or
// parks it. The composition root (#159) builds one per workspace and runs exactly one loop for it.
//
// Order. The state port returns rows oldest first and withholds any row behind an undone, not yet
// due row of the same incident; within a pass, a row that is held or deferred also stops the rest
// of its incident's rows. A parked row stops nothing.
//
// create-issue (main 9.1). Search for the label `snapwing-<incidentId>`, create the issue with that
// label only when none is found, append `filed { jiraKey }` with `expectedSeq` (a conflict is
// retried from a fresh read; an incident already filed is left alone), rewrite the implementation
// request's placeholder `@issue` to the real key and write the `Implementation Prompt` field
// (prompt.ts, #113; `prompt-failed` when it no longer validates), call `continueIncident`,
// upload the screenshots not yet attached, tell `screenshotsAttached`, then ack. A crash anywhere in
// that sequence repeats it without a second issue; `continueIncident` is a singleton job, so a second
// call is harmless.
// Jira's search is eventually consistent, so a retry within seconds of a create can still miss the
// label; the retry delay (1 s doubling) makes that unlikely, not impossible.
//
// Batching (B 7.1). An `add-comment` row with a `batch_key` waits until 60 s after its `createdAt`
// (held with `deferOutbox` and no error, so it is not a failure); then every pending comment row
// with that key created inside the window becomes one comment, one paragraph block per row.
//
// Transitions (#268). A row names a logical target; `statuses.ts` maps it to the project's status by
// category (read once per project) and the config override, and the client finds the transition by
// that status's name.
//
// Failures. HTTP 429 pauses the whole drain for `Retry-After` and leaves the row as it was: not
// failed, no attempt counted (B 11). A payload that does not validate, a Jira 400, a missing issue,
// a target the project has no status for, and a missing transition are parked at once, since
// sending them again cannot succeed. Anything
// else is deferred with a doubling delay and parked once `maxAttempts` sends have failed. Parked
// rows and their errors are what `metrics()` reports for `/metrics`.

import type { IncidentEvent, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import { isExpectedSeqConflict, type OutboxItem } from '@snapwing/pipeline/contracts/state.ts';
import type { JiraStatusOverrides } from '@snapwing/pipeline/jira/statuses.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { JiraNotFoundError, JiraRateLimitError, JiraTransitionNotFoundError, JiraValidationError, type JiraClient } from '../client/index.ts';
import {
  OutboxValidationError,
  createAssigneeResolver,
  fetchScreenshot,
  findOrCreateIssue,
  parseJiraRow,
  sendOp,
  uploadScreenshots,
  type AddCommentOp,
  type CreateIssueOp,
  type JiraOp,
  type LoadScreenshot,
  type ScreenshotRef,
} from './ops.ts';
import { requireCustomFieldIds } from './fields.ts';
import { finalizePrompt } from './prompt.ts';
import { createStatusResolver, JiraStatusMappingError } from './statuses.ts';

export const DEFAULT_BATCH_SIZE = 50;
export const DEFAULT_POLL_INTERVAL_MS = 1000;
export const DEFAULT_MAX_ATTEMPTS = 8;
export const DEFAULT_RETRY_DELAY_MS = 1000;
export const DEFAULT_MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
/** B 7.1: comments sharing a `batch_key` within this window become one. */
export const COMMENT_WINDOW_MS = 60 * 1000;
/** `filed` appends retried on `ExpectedSeqConflictError` before the row is deferred. */
const FILED_APPEND_TRIES = 5;
/** Parked rows `metrics()` lists. */
const METRICS_PARKED_LIMIT = 100;

export interface JiraProjectorOptions {
  state: StatePort;
  client: JiraClient;
  workspaceId: string;
  /** `IncidentOrchestrator.continueIncident`: runs the incident on after `filed`. */
  continueIncident: (incidentId: string) => Promise<unknown>;
  /**
   * Custom field name to Jira `customfield_NNNNN` id, from `customFieldIdsFromEnv` (the ids
   * `pnpm jira:bootstrap` writes). Required: `createJiraProjector` throws `JiraFieldConfigError` when
   * any of `Implementation Prompt`, `Conversation Link`, `Autonomy Level`, `Agent Status` has none.
   */
  customFieldIds: Readonly<Record<string, string>>;
  /**
   * The status a logical target maps to in place of the category guess, from `AppConfig.jira.statuses`
   * (`<jira><status logical="backlog" name="..."/></jira>`, #268). Default none.
   */
  statusOverrides?: JiraStatusOverrides;
  /** Fetches a screenshot for upload; default a plain GET (`fetchScreenshot`). */
  loadScreenshot?: LoadScreenshot;
  /**
   * Called once a created issue has every screenshot its row named, so whoever kept the bytes for the
   * upload can drop them. Best effort: a failure goes to `onError` and never retries the row.
   */
  screenshotsAttached?: (refs: readonly ScreenshotRef[]) => Promise<void>;
  /** Clock for holds, pauses, and backoff; use the store's clock. Default `() => new Date()`. */
  now?: () => Date;
  batchSize?: number;
  pollIntervalMs?: number;
  /** Failed sends before a row is parked. */
  maxAttempts?: number;
  /** First retry delay; doubles per attempt up to `maxRetryDelayMs`. */
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  /** Errors the loop survives (a pass that threw, for example with the database down). */
  onError?: (error: unknown) => void;
}

export interface DrainReport {
  /** Row ids sent (or found already done in Jira) and acked. */
  sent: string[];
  /** Comment rows held for their batch window. */
  held: string[];
  /** Rows deferred after a failed send. */
  deferred: string[];
  parked: string[];
  /** Set while the drain is paused by a 429. */
  pausedUntil?: string;
  /** Rows the state port returned for this pass. */
  drained: number;
}

export interface JiraProjector {
  /** One pass over the due rows. Concurrent calls share the pass in flight. */
  drainOnce(): Promise<DrainReport>;
  /** Starts the polling loop (one per workspace). */
  start(): void;
  /** Stops the loop and waits for the pass in flight. */
  stop(): Promise<void>;
  /** When a 429 pause ends, or undefined when the drain is not paused. */
  pausedUntil(): Date | undefined;
  /** Prometheus text: the pause, and each parked row with its error (B 10). */
  metrics(): Promise<string>;
}

type Outcome = 'sent' | 'held';

export function createJiraProjector(options: JiraProjectorOptions): JiraProjector {
  const { state, client, workspaceId } = options;
  const now = options.now ?? (() => new Date());
  const customFieldIds = requireCustomFieldIds(options.customFieldIds);
  const statuses = createStatusResolver(client, options.statusOverrides ?? {});
  const assignees = createAssigneeResolver(client, now);
  const loadScreenshot = options.loadScreenshot ?? fetchScreenshot;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const onError = options.onError ?? (() => undefined);

  let paused: Date | undefined;
  let inFlight: Promise<DrainReport> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const iso = (ms: number): string => new Date(ms).toISOString();

  async function recordFiled(row: OutboxItem, incidentId: string, jiraKey: string): Promise<void> {
    for (let i = 0; i < FILED_APPEND_TRIES; i++) {
      const log: IncidentEvent[] = await state.read(incidentId);
      if (log.some((e) => e.type === 'filed')) return;
      const filed: NewEvent<'filed'> = {
        workspaceId: row.workspaceId,
        incidentId,
        type: 'filed',
        v: 1,
        source: 'jira',
        occurredAt: now().toISOString(),
        payload: { jiraKey },
      };
      try {
        await state.append(incidentId, [filed], log.at(-1)?.seq ?? 0);
        return;
      } catch (err) {
        if (!isExpectedSeqConflict(err)) throw err;
      }
    }
    throw new Error(`filed for ${incidentId} kept conflicting after ${FILED_APPEND_TRIES} tries`);
  }

  async function fileIssue(row: OutboxItem, op: CreateIssueOp): Promise<Outcome> {
    const found = await findOrCreateIssue(client, op, customFieldIds, assignees);
    await recordFiled(row, op.incidentId, found.key);
    // Before the fixer can start: it reads the latest artifact version, which must name the real key.
    await finalizePrompt({
      state,
      client,
      incidentId: op.incidentId,
      issueKey: found.key,
      projectKey: (op.fields['project'] as { key: string }).key,
      fieldId: customFieldIds['Implementation Prompt'] as string,
      createdBy: 'jira-projector',
    });
    await options.continueIncident(op.incidentId);
    await uploadScreenshots(client, found.key, op.screenshots, found.attached, loadScreenshot);
    if (op.screenshots.length > 0) await options.screenshotsAttached?.(op.screenshots).catch((e: unknown) => options.onError?.(e));
    await state.ackOutbox([row.id]);
    return 'sent';
  }

  /** Sends a batched comment once its window has closed, merged with the rows that share its key. */
  async function sendComment(row: OutboxItem, op: AddCommentOp, rows: readonly OutboxItem[], consumed: Set<string>, report: DrainReport): Promise<Outcome> {
    const key = row.batchKey;
    if (key === undefined) {
      await sendOp(client, op, customFieldIds, statuses, assignees);
      await state.ackOutbox([row.id]);
      return 'sent';
    }
    const closes = Date.parse(row.createdAt) + COMMENT_WINDOW_MS;
    if (now().getTime() < closes) {
      await state.deferOutbox(row.id, iso(closes));
      report.held.push(row.id);
      return 'held';
    }
    const group: { row: OutboxItem; text: string }[] = [{ row, text: op.text }];
    for (const other of rows) {
      if (other.id === row.id || consumed.has(other.id) || other.op !== 'add-comment' || other.batchKey !== key) continue;
      if (Date.parse(other.createdAt) >= closes) continue;
      let parsed: JiraOp;
      try {
        parsed = parseJiraRow(other);
      } catch {
        continue; // parked when the loop reaches it
      }
      if (parsed.op !== 'add-comment' || parsed.issueKey !== op.issueKey) continue;
      group.push({ row: other, text: parsed.text });
    }
    await sendOp(client, { op: 'add-comment', issueKey: op.issueKey, text: group.map((g) => g.text).join('\n\n') }, customFieldIds, statuses, assignees);
    const ids = group.map((g) => g.row.id);
    await state.ackOutbox(ids);
    for (const id of ids) consumed.add(id);
    report.sent.push(...ids.slice(1));
    return 'sent';
  }

  function permanent(err: unknown): boolean {
    return (
      err instanceof OutboxValidationError ||
      err instanceof JiraValidationError ||
      err instanceof JiraNotFoundError ||
      err instanceof JiraTransitionNotFoundError ||
      err instanceof JiraStatusMappingError
    );
  }

  function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /** Defers or parks a row whose send failed. Resolves true when the row was parked. */
  async function failed(row: OutboxItem, err: unknown): Promise<boolean> {
    const attempts = row.attempts + 1;
    if (permanent(err)) {
      await state.parkOutbox(row.id, message(err));
      return true;
    }
    if (attempts >= maxAttempts) {
      await state.parkOutbox(row.id, `gave up after ${attempts} attempts: ${message(err)}`);
      return true;
    }
    const delay = Math.min(retryDelayMs * 2 ** (attempts - 1), maxRetryDelayMs);
    await state.deferOutbox(row.id, iso(now().getTime() + delay), message(err));
    return false;
  }

  async function pass(): Promise<DrainReport> {
    const report: DrainReport = { sent: [], held: [], deferred: [], parked: [], drained: 0 };
    if (paused !== undefined) {
      if (now().getTime() < paused.getTime()) {
        report.pausedUntil = paused.toISOString();
        return report;
      }
      paused = undefined;
    }
    const rows = await state.drainOutbox('jira', batchSize, workspaceId);
    report.drained = rows.length;
    const blocked = new Set<string>();
    const consumed = new Set<string>();
    for (const row of rows) {
      if (consumed.has(row.id)) continue;
      const lane = row.incidentId;
      if (lane !== undefined && blocked.has(lane)) continue;
      try {
        const op = parseJiraRow(row);
        let outcome: Outcome;
        if (op.op === 'create-issue') {
          outcome = await fileIssue(row, op);
        } else if (op.op === 'add-comment') {
          outcome = await sendComment(row, op, rows, consumed, report);
        } else {
          await sendOp(client, op, customFieldIds, statuses, assignees);
          await state.ackOutbox([row.id]);
          outcome = 'sent';
        }
        consumed.add(row.id);
        if (outcome === 'sent') report.sent.push(row.id);
        else if (lane !== undefined) blocked.add(lane);
      } catch (err) {
        if (err instanceof JiraRateLimitError) {
          paused = new Date(now().getTime() + err.retryAfterMs);
          report.pausedUntil = paused.toISOString();
          return report;
        }
        if (await failed(row, err)) {
          report.parked.push(row.id);
        } else {
          report.deferred.push(row.id);
          if (lane !== undefined) blocked.add(lane);
        }
      }
    }
    return report;
  }

  function pausedUntil(): Date | undefined {
    return paused !== undefined && now().getTime() < paused.getTime() ? paused : undefined;
  }

  function drainOnce(): Promise<DrainReport> {
    inFlight ??= pass().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  function schedule(delayMs: number): void {
    if (!running) return;
    timer = setTimeout(() => {
      timer = undefined;
      void loop();
    }, delayMs);
  }

  async function loop(): Promise<void> {
    let delay = pollIntervalMs;
    try {
      const report = await drainOnce();
      if (report.pausedUntil !== undefined) delay = Math.max(0, Date.parse(report.pausedUntil) - now().getTime());
      else if (report.drained >= batchSize) delay = 0;
    } catch (err) {
      onError(err);
    }
    schedule(delay);
  }

  return {
    drainOnce,
    start() {
      if (running) return;
      running = true;
      schedule(0);
    },
    async stop() {
      running = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await inFlight?.catch(() => undefined);
    },
    pausedUntil,
    async metrics() {
      const parked = (await state.listParkedOutbox('jira', METRICS_PARKED_LIMIT)).filter((r) => r.workspaceId === workspaceId);
      return renderJiraProjectorMetrics(workspaceId, parked, pausedUntil(), now());
    },
  };
}

/** Escapes a Prometheus label value. */
function label(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Prometheus text for one workspace's projector: seconds left in a 429 pause, and one line per
 * parked row (up to the 100 most recent) with its op, incident, and error; the value is its attempts.
 */
export function renderJiraProjectorMetrics(workspaceId: string, parked: readonly OutboxItem[], pausedUntil: Date | undefined, at: Date): string {
  const ws = `workspace="${label(workspaceId)}"`;
  const pause = pausedUntil === undefined ? 0 : Math.max(0, (pausedUntil.getTime() - at.getTime()) / 1000);
  const lines = [
    '# HELP snapwing_jira_drain_paused_seconds Seconds left in the Jira drain pause after an HTTP 429; 0 when draining.',
    '# TYPE snapwing_jira_drain_paused_seconds gauge',
    `snapwing_jira_drain_paused_seconds{${ws}} ${pause}`,
    '# HELP snapwing_outbox_parked_rows Outbox rows parked (given up on), per target and workspace.',
    '# TYPE snapwing_outbox_parked_rows gauge',
    `snapwing_outbox_parked_rows{target="jira",${ws}} ${parked.length}`,
    '# HELP snapwing_outbox_parked_row One parked outbox row with its error; the value is its attempts.',
    '# TYPE snapwing_outbox_parked_row gauge',
    ...parked.map(
      (r) =>
        `snapwing_outbox_parked_row{target="jira",${ws},id="${label(r.id)}",op="${label(r.op)}",incident="${label(r.incidentId ?? '')}",error="${label(r.lastError ?? '')}"} ${r.attempts}`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}
