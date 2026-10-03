// The GitHub projector (B 7.1): the one writer of `target='github'` outbox rows for a workspace. It
// drains `add-comment { repo, prNumber, text }` rows (`pipeline/src/state/projections/outbox/github.ts`,
// and the hold and claim expiry rows of `signals/holds.ts`) and posts each as a pull request comment
// with an installation token scoped to that repository. It is the Jira projector's twin
// (`jira/projector/drain.ts`): same order rules, same pause, same parking, same `metrics()` shape.
//
// Batching (B 7.1). An `add-comment` row with a `batch_key` waits until 60 s after its `createdAt`
// (held with `deferOutbox` and no error, so it is not a failure); then every pending row with that
// key, on the same repository and pull request, created inside the window becomes one comment, one
// paragraph per row. A row with no `batch_key` is sent at once.
//
// Failures. HTTP 429, and 403 with a rate-limit signal (primary or secondary), pause the whole drain
// for `Retry-After` (or the reset time) and leave the row as it was: not failed, no attempt counted
// (B 11). A payload that does not validate, a 404 (the repository or pull request is gone, or the app
// cannot see it) and a 422 are parked at once, since sending them again cannot succeed. Anything else
// is deferred with a doubling delay and parked once `maxAttempts` sends have failed.

import type { OutboxItem } from '@snapwing/pipeline/contracts/state.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import type { GitHubAuth } from './auth.ts';
import { GitHubNotFoundError, GitHubRateLimitError, GitHubValidationError, createGitHubTransport, type GitHubTransport } from './client.ts';
import { repoFullName } from './repo.ts';

export const DEFAULT_BATCH_SIZE = 50;
export const DEFAULT_POLL_INTERVAL_MS = 1000;
export const DEFAULT_MAX_ATTEMPTS = 8;
export const DEFAULT_RETRY_DELAY_MS = 1000;
export const DEFAULT_MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
/** B 7.1: comments sharing a `batch_key` within this window become one. */
export const COMMENT_WINDOW_MS = 60 * 1000;
/** Parked rows `metrics()` lists. */
const METRICS_PARKED_LIMIT = 100;

export interface GitHubProjectorOptions {
  state: StatePort;
  auth: GitHubAuth;
  workspaceId: string;
  fetch?: typeof fetch;
  /** Default `https://api.github.com`. */
  apiBase?: string;
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

export interface GitHubDrainReport {
  /** Row ids sent and acked. */
  sent: string[];
  /** Comment rows held for their batch window. */
  held: string[];
  /** Rows deferred after a failed send. */
  deferred: string[];
  parked: string[];
  /** Set while the drain is paused by a rate limit. */
  pausedUntil?: string;
  /** Rows the state port returned for this pass. */
  drained: number;
}

export interface GitHubProjector {
  /** One pass over the due rows. Concurrent calls share the pass in flight. */
  drainOnce(): Promise<GitHubDrainReport>;
  /** Starts the polling loop (one per workspace). */
  start(): void;
  /** Stops the loop and waits for the pass in flight. */
  stop(): Promise<void>;
  /** When a rate limit pause ends, or undefined when the drain is not paused. */
  pausedUntil(): Date | undefined;
  /** Prometheus text: the pause, and each parked row with its error (B 10). */
  metrics(): Promise<string>;
}

/** A GitHub row that is not a well formed `add-comment`. Never retried. */
export class GitHubOutboxValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubOutboxValidationError';
  }
}

export interface AddPrCommentOp {
  /** `owner/name`. */
  repo: string;
  prNumber: number;
  text: string;
}

/** Validates a `github` outbox row; throws `GitHubOutboxValidationError` when it cannot be sent. */
export function parseGitHubRow(row: OutboxItem): AddPrCommentOp {
  if (row.op !== 'add-comment') throw new GitHubOutboxValidationError(`unknown github op "${row.op}"`);
  const { repo, prNumber, text } = row.payload;
  if (typeof repo !== 'string' || repo === '') throw new GitHubOutboxValidationError('add-comment needs a repo');
  if (typeof prNumber !== 'number' || !Number.isInteger(prNumber) || prNumber <= 0) throw new GitHubOutboxValidationError('add-comment needs a prNumber');
  if (typeof text !== 'string' || text.trim() === '') throw new GitHubOutboxValidationError('add-comment needs text');
  return { repo: repoFullName(repo), prNumber, text };
}

type Outcome = 'sent' | 'held';

export function createGitHubProjector(options: GitHubProjectorOptions): GitHubProjector {
  const { state, auth, workspaceId } = options;
  const now = options.now ?? (() => new Date());
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const onError = options.onError ?? (() => undefined);

  let paused: Date | undefined;
  let inFlight: Promise<GitHubDrainReport> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const transports = new Map<string, GitHubTransport>();
  const transportFor = (repo: string): GitHubTransport => {
    let t = transports.get(repo);
    if (t === undefined) {
      t = createGitHubTransport(auth, {
        repo,
        now,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.apiBase === undefined ? {} : { apiBase: options.apiBase }),
      });
      transports.set(repo, t);
    }
    return t;
  };

  const iso = (ms: number): string => new Date(ms).toISOString();

  async function postComment(op: AddPrCommentOp, text: string): Promise<void> {
    await transportFor(op.repo)({
      method: 'POST',
      path: `/repos/${op.repo}/issues/${op.prNumber}/comments`,
      permissions: { pull_requests: 'write' },
      body: { body: text },
    });
  }

  /** Sends a comment once its window has closed, merged with the rows that share its key. */
  async function sendComment(row: OutboxItem, op: AddPrCommentOp, rows: readonly OutboxItem[], consumed: Set<string>, report: GitHubDrainReport): Promise<Outcome> {
    const key = row.batchKey;
    if (key === undefined) {
      await postComment(op, op.text);
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
      let parsed: AddPrCommentOp;
      try {
        parsed = parseGitHubRow(other);
      } catch {
        continue; // parked when the loop reaches it
      }
      if (parsed.repo !== op.repo || parsed.prNumber !== op.prNumber) continue;
      group.push({ row: other, text: parsed.text });
    }
    await postComment(op, group.map((g) => g.text).join('\n\n'));
    const ids = group.map((g) => g.row.id);
    await state.ackOutbox(ids);
    for (const id of ids) consumed.add(id);
    report.sent.push(...ids.slice(1));
    return 'sent';
  }

  function permanent(err: unknown): boolean {
    return err instanceof GitHubOutboxValidationError || err instanceof GitHubNotFoundError || err instanceof GitHubValidationError;
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

  async function pass(): Promise<GitHubDrainReport> {
    const report: GitHubDrainReport = { sent: [], held: [], deferred: [], parked: [], drained: 0 };
    if (paused !== undefined) {
      if (now().getTime() < paused.getTime()) {
        report.pausedUntil = paused.toISOString();
        return report;
      }
      paused = undefined;
    }
    const rows = await state.drainOutbox('github', batchSize, workspaceId);
    report.drained = rows.length;
    const blocked = new Set<string>();
    const consumed = new Set<string>();
    for (const row of rows) {
      if (consumed.has(row.id)) continue;
      const lane = row.incidentId;
      if (lane !== undefined && blocked.has(lane)) continue;
      try {
        const outcome = await sendComment(row, parseGitHubRow(row), rows, consumed, report);
        consumed.add(row.id);
        if (outcome === 'sent') report.sent.push(row.id);
        else if (lane !== undefined) blocked.add(lane);
      } catch (err) {
        if (err instanceof GitHubRateLimitError) {
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

  function drainOnce(): Promise<GitHubDrainReport> {
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
      const parked = (await state.listParkedOutbox('github', METRICS_PARKED_LIMIT)).filter((r) => r.workspaceId === workspaceId);
      return renderGitHubProjectorMetrics(workspaceId, parked, pausedUntil(), now());
    },
  };
}

/** Escapes a Prometheus label value. */
function label(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Prometheus text for one workspace's GitHub projector (the Jira one's shape, `target="github"`). */
export function renderGitHubProjectorMetrics(workspaceId: string, parked: readonly OutboxItem[], pausedUntil: Date | undefined, at: Date): string {
  const ws = `workspace="${label(workspaceId)}"`;
  const pause = pausedUntil === undefined ? 0 : Math.max(0, (pausedUntil.getTime() - at.getTime()) / 1000);
  const lines = [
    '# HELP snapwing_github_drain_paused_seconds Seconds left in the GitHub drain pause after a rate limit; 0 when draining.',
    '# TYPE snapwing_github_drain_paused_seconds gauge',
    `snapwing_github_drain_paused_seconds{${ws}} ${pause}`,
    '# HELP snapwing_outbox_parked_rows Outbox rows parked (given up on), per target and workspace.',
    '# TYPE snapwing_outbox_parked_rows gauge',
    `snapwing_outbox_parked_rows{target="github",${ws}} ${parked.length}`,
    '# HELP snapwing_outbox_parked_row One parked outbox row with its error; the value is its attempts.',
    '# TYPE snapwing_outbox_parked_row gauge',
    ...parked.map(
      (r) =>
        `snapwing_outbox_parked_row{target="github",${ws},id="${label(r.id)}",op="${label(r.op)}",incident="${label(r.incidentId ?? '')}",error="${label(r.lastError ?? '')}"} ${r.attempts}`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}
