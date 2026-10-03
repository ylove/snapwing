// src/reconcile/job.ts: the reconciler (B 8), the low-frequency backstop for webhooks that never
// arrived. Active monitoring (A 4.5) covers critical incidents; this covers the rest.
//
// Flow:
//   registerReconcileJob  registers the `reconcile` handler and its schedule through
//                         `WorkflowPort.cron` (default every 15 minutes, `*/15 * * * *`).
//   runReconcile          selects open incidents whose `incidents.waiting_on` is older than the
//                         stale threshold (default PT30M; `findStaleWaits`, oldest first, at most
//                         `batchSize`), asks the injected sources of truth whether the world moved on,
//                         and appends what the webhooks would have:
//     ci-green / ci-red   when the incident waits on `ci` (or is in `ci` / `ci-retry`) and has a PR:
//                         `prChecks(pr)` finished for the head SHA, and the log has no `ci-green` or
//                         `ci-red` for that PR and head SHA (one per head SHA, as the GitHub webhook).
//     merged              when the incident has a PR and has not merged yet: `prState(pr)` says merged
//                         and the log has no `merged` for that PR. `levelAtMergeTime` is the level in
//                         force (the row, else the log; 0 when neither knows). After any CI event, so
//                         `ci` moves to `mergeable` before `merged` lands.
//     jira-transitioned   when the incident has a Jira key: `issueStatus(key)` says the last status
//                         change was a person's (the agent's own transitions never become events,
//                         B 7.3), it led to the current status, the log's latest `jira-transitioned`
//                         for the key is not already at that status, and the log does not hold that
//                         very change. The actor is the person, role `human`, when the source names them.
//                         Every emitted payload carries `reconciled: true`, the event `source: 'agent'`,
//                         and `occurredAt` the world's time when the source gives it, else the clock.
//   followUp              after the append commits, each new event goes to the injected callback with
//                         the incident row as it now stands, which starts what the matching webhook
//                         would have started (`merge.evaluate` after a CI event, the fixer after an In
//                         Progress transition). Wiring is the app's (compose.ts).
//
// Idempotent across runs: every decision is made against the log the append reads, so a second run,
// or a webhook landing between the source call and the append, finds the event and emits nothing.
// Every append passes `expectedSeq` and re-reads on a conflict (`appendDecided`). A failing source or
// follow-up for one incident does not stop the others; the run throws an AggregateError at the end so
// the worker logs it, and the next run asks again. A follow-up that failed after its event committed
// is not retried by the next run (the event is in the log); the error says which.
//
// Spec silent on the source shapes; they are the smallest answers the decisions above need. The app
// implements them over GitHub (#145) and Jira.

import type { AutonomyLevel, EventActor, EventPayloads, IncidentEvent, NewEvent } from '../contracts/events.ts';
import type { IncidentView, IncidentWaitingOn } from '../contracts/state.ts';
import { appendDecided, currentLevel } from '../fixer/job.ts';
import type { StatePort } from '../ports/state.ts';
import type { WorkflowPort } from '../ports/workflow.ts';
import { findStaleWaits } from '../state/waiting.ts';
import { parseDuration } from '../util/duration.ts';
import { isReconciled, type ReconciledEventType } from './marker.ts';

export { isReconciled, isReconciledPayload, RECONCILED_EVENT_TYPES, type ReconciledEventType } from './marker.ts';

export const RECONCILE_JOB = 'reconcile';
/** B 8: every 15 minutes. */
export const DEFAULT_RECONCILE_CRON = '*/15 * * * *';
/** B 8: a wait older than 30 minutes is worth asking about. */
export const DEFAULT_STALE_AFTER = 'PT30M';
/** Incidents asked about per run, oldest wait first; the rest wait for the next run. */
export const DEFAULT_RECONCILE_BATCH = 200;

// Sources of truth ---------------------------------------------------------------------------------

/** The pull request an incident's `pr_number` names, in the incident's repo when it has one. */
export interface PrRef {
  incidentId: string;
  prNumber: number;
  repo?: string;
}

/** The required checks for the PR's current head. `pending` until every one has completed. */
export type PrChecks =
  | { state: 'pending'; headSha: string }
  | { state: 'green'; headSha: string; completedAt?: string }
  | { state: 'red'; headSha: string; failingChecks: string[]; completedAt?: string };

export type PrState = { state: 'open' | 'closed' } | { state: 'merged'; mergeCommitSha: string; mergedAt?: string };

/** A Jira issue's workflow status and, from its changelog, the last status change. */
export interface IssueStatus {
  status: string;
  /** Absent when the status never changed since the issue was created. */
  lastTransition?: {
    from: string;
    to: string;
    /** ISO 8601. */
    at: string;
    /** True when the agent's own account made the change (B 7.3); those never become events. */
    byAgent: boolean;
    /** The person's account id, when the changelog names one. */
    actorId?: string;
  };
}

export interface ReconcileSources {
  prChecks(pr: PrRef): Promise<PrChecks>;
  prState(pr: PrRef): Promise<PrState>;
  /** Null when the issue no longer exists. */
  issueStatus(key: string): Promise<IssueStatus | null>;
}

// Deps -----------------------------------------------------------------------------------------------

export interface ReconcileConfig {
  /** Cron expression for the schedule (default `*\/15 * * * *`). */
  cron?: string;
  /** ISO 8601 duration a wait must exceed (default PT30M). */
  staleAfter?: string;
  /** Incidents per run (default 200). */
  batchSize?: number;
}

export interface ReconcileDeps {
  state: StatePort;
  workflow: WorkflowPort;
  sources: ReconcileSources;
  /** Starts what the matching webhook would have started; called once per emitted event, after it commits. */
  followUp(event: IncidentEvent<ReconciledEventType>, incident: IncidentView): Promise<void>;
  clock(): Date;
  config?: ReconcileConfig;
}

export interface ReconcileFailure {
  incidentId: string;
  stage: 'source' | 'append' | 'follow-up';
  error: unknown;
}

export interface ReconcileReport {
  /** Incidents whose wait was stale and that were asked about. */
  checked: string[];
  /** Every event this run appended, in append order. */
  emitted: IncidentEvent<ReconciledEventType>[];
  failures: ReconcileFailure[];
}

// Job --------------------------------------------------------------------------------------------------

/** Registers the `reconcile` handler and schedules it through `WorkflowPort.cron` (B 8). */
export async function registerReconcileJob(deps: ReconcileDeps): Promise<void> {
  deps.workflow.work(RECONCILE_JOB, async () => {
    const report = await runReconcile(deps);
    if (report.failures.length > 0) {
      const ids = report.failures.map((f) => `${f.incidentId} (${f.stage})`).join(', ');
      throw new AggregateError(
        report.failures.map((f) => f.error),
        `reconcile: ${report.failures.length} incident(s) failed: ${ids}`,
      );
    }
  });
  await deps.workflow.cron(RECONCILE_JOB, deps.config?.cron ?? DEFAULT_RECONCILE_CRON);
}

/** One reconcile pass at the clock's current time. */
export async function runReconcile(deps: ReconcileDeps): Promise<ReconcileReport> {
  const staleAfterMs = parseDuration(deps.config?.staleAfter ?? DEFAULT_STALE_AFTER);
  const before = new Date(deps.clock().getTime() - staleAfterMs);
  const waits = await findStaleWaits(deps.state, before, deps.config?.batchSize ?? DEFAULT_RECONCILE_BATCH);
  const report: ReconcileReport = { checked: [], emitted: [], failures: [] };
  for (const wait of waits) {
    report.checked.push(wait.incidentId);
    await reconcileIncident(deps, wait.incidentId, wait.waitingOn, report);
  }
  return report;
}

// Private ------------------------------------------------------------------------------------------

/** What the sources said about one incident; undefined where a source was not asked. */
export interface ReconcileAnswers {
  checks?: PrChecks;
  pr?: PrState;
  issue?: IssueStatus | null;
}

const MERGED_OR_LATER: ReadonlySet<IncidentView['status']> = new Set(['merged', 'deployed:staging', 'deployed:production', 'reverted']);

async function reconcileIncident(deps: ReconcileDeps, incidentId: string, waitingOn: IncidentWaitingOn, report: ReconcileReport): Promise<void> {
  const incident = await deps.state.getIncident(incidentId);
  if (incident === null) return;

  let answers: ReconcileAnswers;
  try {
    answers = await ask(deps.sources, incident, waitingOn);
  } catch (error) {
    report.failures.push({ incidentId, stage: 'source', error });
    return;
  }

  let appended: IncidentEvent<ReconciledEventType>[];
  try {
    const result = await appendDecided(deps.state, incidentId, (log) => missingEvents(deps.clock, incident, answers, log));
    if (!result.appended) return;
    const after = await deps.state.read(incidentId, (result.before.at(-1)?.seq ?? 0) + 1);
    appended = after.filter((e) => e.seq <= result.seq && isReconciled(e)) as IncidentEvent<ReconciledEventType>[];
  } catch (error) {
    report.failures.push({ incidentId, stage: 'append', error });
    return;
  }
  report.emitted.push(...appended);

  const now = (await deps.state.getIncident(incidentId)) ?? incident;
  for (const event of appended) {
    try {
      await deps.followUp(event, now);
    } catch (error) {
      report.failures.push({ incidentId, stage: 'follow-up', error });
    }
  }
}

async function ask(sources: ReconcileSources, incident: IncidentView, waitingOn: IncidentWaitingOn): Promise<ReconcileAnswers> {
  const answers: ReconcileAnswers = {};
  if (incident.prNumber !== undefined) {
    const pr: PrRef = { incidentId: incident.id, prNumber: incident.prNumber, ...(incident.repo === undefined ? {} : { repo: incident.repo }) };
    if (waitingOn.kind === 'ci' || incident.status === 'ci' || incident.status === 'ci-retry') {
      answers.checks = await sources.prChecks(pr);
    }
    if (!MERGED_OR_LATER.has(incident.status)) {
      answers.pr = await sources.prState(pr);
    }
  }
  if (incident.jiraKey !== undefined) {
    answers.issue = await sources.issueStatus(incident.jiraKey);
  }
  return answers;
}

/**
 * The events the log is missing, given the answers; undefined when it is missing none. Shared with
 * active monitoring (monitor/active.ts, A 4.5), which asks the same sources on its own schedule.
 */
export function missingEvents(clock: () => Date, incident: IncidentView, answers: ReconcileAnswers, log: readonly IncidentEvent[]): NewEvent[] | undefined {
  const out: NewEvent[] = [];
  const at = (worldTime: string | undefined): string => (worldTime !== undefined && !Number.isNaN(Date.parse(worldTime)) ? new Date(worldTime).toISOString() : clock().toISOString());
  const prNumber = incident.prNumber;

  const checks = answers.checks;
  if (prNumber !== undefined && checks !== undefined && checks.state !== 'pending') {
    const known = log.some((e) => (e.type === 'ci-green' || e.type === 'ci-red') && e.payload.prNumber === prNumber && e.payload.headSha === checks.headSha);
    if (!known) {
      out.push(
        checks.state === 'green'
          ? event(incident, 'ci-green', { prNumber, headSha: checks.headSha, reconciled: true }, at(checks.completedAt))
          : event(incident, 'ci-red', { prNumber, headSha: checks.headSha, failingChecks: [...checks.failingChecks], reconciled: true }, at(checks.completedAt)),
      );
    }
  }

  const pr = answers.pr;
  if (prNumber !== undefined && pr?.state === 'merged') {
    const known = log.some((e) => e.type === 'merged' && e.payload.prNumber === prNumber);
    if (!known) {
      const level: AutonomyLevel = incident.autonomyLevel ?? currentLevel(log) ?? 0;
      out.push(event(incident, 'merged', { prNumber, mergeCommitSha: pr.mergeCommitSha, levelAtMergeTime: level, reconciled: true }, at(pr.mergedAt)));
    }
  }

  const issue = answers.issue;
  const jiraKey = incident.jiraKey;
  if (jiraKey !== undefined && issue !== undefined && issue !== null) {
    const missing = missingTransition(jiraKey, issue, log);
    if (missing !== undefined) {
      out.push(event(incident, 'jira-transitioned', { jiraKey, from: missing.from, to: missing.to, reconciled: true }, at(missing.at), missing.actor));
    }
  }

  return out.length === 0 ? undefined : out;
}

function missingTransition(jiraKey: string, issue: IssueStatus, log: readonly IncidentEvent[]): { from: string; to: string; at: string; actor?: EventActor } | undefined {
  const t = issue.lastTransition;
  if (t === undefined || t.byAgent || t.to !== issue.status) return undefined;
  const logged = log.filter((e): e is IncidentEvent<'jira-transitioned'> => e.type === 'jira-transitioned' && e.payload.jiraKey === jiraKey);
  if (logged.at(-1)?.payload.to === issue.status) return undefined;
  const atMs = Date.parse(t.at);
  if (logged.some((e) => e.payload.from === t.from && e.payload.to === t.to && Date.parse(e.occurredAt) === atMs)) return undefined;
  return { from: t.from, to: t.to, at: t.at, ...(t.actorId === undefined ? {} : { actor: { id: t.actorId, role: 'human' } }) };
}

function event<T extends ReconciledEventType>(incident: IncidentView, type: T, payload: EventPayloads[T], occurredAt: string, actor?: EventActor): NewEvent<T> {
  const e = {
    workspaceId: incident.workspaceId,
    incidentId: incident.id,
    type,
    v: 1,
    source: 'agent',
    ...(actor === undefined ? {} : { actor }),
    occurredAt,
    payload,
  };
  return e as unknown as NewEvent<T>;
}
