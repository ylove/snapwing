// src/monitor/active.ts: active monitoring for critical incidents (A 4.5, B 5 heartbeat and stall
// timers, B 8). A factory over injected interfaces and a clock; compose wires it.
//
// Qualifying. An open incident qualifies while its priority is Highest (`priority`), the A 1.4
// reaction ladder reached its outage step (`outage-score`, `escalationState`), or its surface is one
// the playbook marks `<critical surface>` (`critical-surface`), checked in that order. `evaluate`
// appends `monitoring-started { qualifiedBy }` (ADR 0014) when an unmonitored incident qualifies, and
// `monitoring-stopped` when a monitored one should stop:
//   downgraded    a human lowered the priority (a `jira-priority-changed` after the run started whose
//                 priority ranks below the one before it, or moves off Highest to a name with no known
//                 order). Every Jira priority event is a person's (the agent's own writes never come
//                 back as events, B 7.3). After a downgrade the incident restarts only on something
//                 newer than the stop: a raise back to Highest or a new outage step; a critical
//                 surface alone does not restart it.
//   disqualified  nothing qualifies it any more (the surface left the playbook's critical list).
// Closing (any terminal status) clears `incidents.monitored` with no event (ADR 0014); `evaluate`
// and every timer then cancel what is left. The reaction ladder's outage step appends its own
// `monitoring-started`; `evaluate` treats that run like its own and arms the timers.
//
// Timers, all durable through the workflow port and all re-derived from the log, so arming twice
// changes nothing and a restart loses nothing:
//   monitor.poll     key `monitor-poll:{incident}`, every `monitor.interval` (default PT60S). Asks the
//                    reconciler's sources (reconcile/job.ts: `prChecks` while CI is awaited, `prState`
//                    until merged) plus the optional `deployments` source, and appends what the log is
//                    missing exactly as the reconciler does (`missingEvents`: `ci-green`, `ci-red`,
//                    `merged`, payloads `reconciled: true`), then `deployed:staging` and
//                    `deployed:production` where the lifecycle takes them (B 5: production only after
//                    staging). Each appended event goes to `followUp` after it commits, as the
//                    reconciler's do. The next poll is scheduled before any source is asked, so a
//                    failing source never ends the chain (a poll that throws earlier schedules the
//                    next one before rethrowing). Each poll also re-checks the qualification
//                    (a downgrade or a close stops monitoring within one interval even when nobody
//                    calls `evaluate`), re-arms the heartbeat and stall timers, and re-evaluates the
//                    escalation ladders while the incident is stalled or a ladder is running.
//   timer.heartbeat  `heartbeat:{incident}`. Heartbeats fall on a fixed cadence from the later of the
//                    last stage change and the start of the run: base + n x `monitor.heartbeat`
//                    (default PT10M), so a stage change restarts the count and no heartbeat posts within
//                    one period of it. The post goes to the incident's thread through the escalation
//                    chat (`EscalationChat`, ladder `heartbeat`, step n): "Still in CI, 12 minutes;
//                    typical for this repo is 9. Watching." The typical time is the median of the
//                    repo's recent CI runs in the log (`review-passed` to the next `ci-green` or
//                    `ci-red`, newest `ciSamples` runs over the most recently updated incidents).
//   timer.stall      `stall:{incident}`, due `monitor.stallAfter` (default PT15M) after the last
//                    progress (or the run's start, when later). On firing stalled it evaluates the
//                    escalation ladders, whose `stalled` fact is `stalled(incident)` here, so a
//                    `<applyWhen monitored="true" stalled="true">` ladder (`stalled-fix`) starts.
//                    Progress unstalls it: the next poll evaluates the ladders, which stop the run
//                    (`no-longer-applies`), and the ladder's own steps re-check the fact first.
//                    Monitoring stopping (a downgrade) or a close stops it the same way.
//
// Progress is any event except the agent's own records and the signals people send about the
// incident: `escalation-ladder` (a ladder's own step must not end the stall it escalates),
// `escalated`, `monitoring-*`, `status-message-posted`, `bot-message-posted`, `waiting-changed`,
// `corrected`, and the reaction, text, and priority signals (`comment`, `text-signal`,
// `jira-priority-changed`), which count toward escalation, not toward the fix.
//
// Stage changes show in the pinned status message (main 12, status/loopback.ts), which edits in place
// at each milestone; the monitor does not post them again and adds the heartbeat between them.

import type { Playbook } from '../config/playbook.ts';
import type { EventType, IncidentEvent, NewEvent } from '../contracts/events.ts';
import { keySegment, timerKey } from '../contracts/jobs.ts';
import { isExpectedSeqConflict, type IncidentView } from '../contracts/state.ts';
import { newEvent } from '../fixer/job.ts';
import { isTerminalStatus, isValidTransition, nextStatus, INITIAL_STATUS, type LifecycleStatus } from '../lifecycle/machine.ts';
import type { StatePort } from '../ports/state.ts';
import type { WorkflowPort } from '../ports/workflow.ts';
import { missingEvents, type PrRef, type ReconcileAnswers, type ReconcileSources, type ReconciledEventType } from '../reconcile/job.ts';
import { escalationState, PRIORITY_ORDER } from '../signals/score.ts';
import { parseDuration } from '../util/duration.ts';
import { sameRepo } from '../util/repo.ts';
import { runningLadders, type EscalationChat, type EscalationLadders } from './ladder.ts';

/** `EscalationPost.ladder` of a heartbeat post. */
export const HEARTBEAT_LADDER = 'heartbeat';
/** A 4.5 default `monitor.interval`; also the retry delay of a poll that threw before reading the playbook. */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;
/** The poll never runs more often than this, whatever the playbook says. */
export const MIN_POLL_INTERVAL_MS = 1_000;
/** CI runs the typical time is the median of. */
export const DEFAULT_CI_SAMPLES = 10;
/** Most recently updated incidents searched for the repo's CI runs. */
export const DEFAULT_CI_HISTORY = 100;

/** Re-reads per decision on `ExpectedSeqConflictError`. */
const MAX_APPEND_ATTEMPTS = 8;

export type QualifiedBy = 'priority' | 'outage-score' | 'critical-surface';
export type MonitorStopReason = 'downgraded' | 'disqualified';

// Sources ----------------------------------------------------------------------------------------

/** The merge commit an incident's deploys must contain. */
export interface DeployRef {
  incidentId: string;
  repo?: string;
  mergeCommitSha: string;
}

/** A successful deployment that contains the merge commit (the deployed sha is it or a later one). */
export interface DeployState {
  stage: 'staging' | 'production';
  commitSha: string;
  deploymentId?: string;
  /** ISO 8601; the event's `occurredAt` when present, else the clock. */
  deployedAt?: string;
}

/**
 * The reconciler's sources (a `ReconcileSources` fits as it is) plus deploys. `deployments` answers
 * at most one deployment per stage; absent, deploys are left to the webhook.
 */
export interface MonitorSources extends Pick<ReconcileSources, 'prChecks' | 'prState'> {
  deployments?(ref: DeployRef): Promise<DeployState[]>;
}

/** What a poll may append. */
export type PolledEventType = ReconciledEventType | 'deployed:staging' | 'deployed:production';

// Deps ---------------------------------------------------------------------------------------------

export interface ActiveMonitorConfig {
  /** CI runs the typical time is the median of (default 10). */
  ciSamples?: number;
  /** Most recently updated incidents searched for them (default 100). */
  ciHistory?: number;
}

export interface ActiveMonitorDeps {
  /** The install's workspace (single tenant), stamped on every event. */
  workspaceId: string;
  state: StatePort;
  workflow: WorkflowPort;
  /** The current playbook, read at every decision (hot reload). */
  playbook: () => Playbook | Promise<Playbook>;
  sources: MonitorSources;
  /** Starts what the matching webhook would have started; called once per polled event, after it commits. */
  followUp?(event: IncidentEvent<PolledEventType>, incident: IncidentView): Promise<void>;
  /** Posts heartbeats to the incident's thread. */
  chat: EscalationChat;
  /** The playbook escalation ladders (monitor/ladder.ts), whose `stalled` fact is `stalled` here. */
  ladders?: Pick<EscalationLadders, 'evaluate'>;
  clock: () => Date;
  config?: ActiveMonitorConfig;
  /** Default `console.warn`. */
  log?: (message: string) => void;
}

/** `monitor.poll`, `timer.heartbeat`, and `timer.stall` job data. */
export interface MonitorTimerData {
  incidentId: string;
}

export type MonitorChange = { started: QualifiedBy } | { stopped: MonitorStopReason };

export interface PollReport {
  /** False when the incident is not monitored (the poll stopped its timers instead). */
  monitored: boolean;
  appended: IncidentEvent<PolledEventType>[];
  failures: { stage: 'source' | 'append' | 'follow-up' | 'ladders'; error: unknown }[];
}

export type HeartbeatOutcome = { posted: true; text: string; next: Date } | { posted: false; reason: 'not-monitored' | 'not-due' | 'no-thread' | 'post-failed'; next?: Date };

export type StallOutcome = { stalled: true } | { stalled: false; next?: Date };

export interface ActiveMonitor {
  /**
   * Starts or stops monitoring as the incident now qualifies, and arms or cancels the timers. Call it
   * after any event that can change the answer: a priority change (`planned`, `escalated`,
   * `jira-priority-changed`), a surface change, a reaction ladder's `monitoring-started`, a close.
   * Running it twice changes nothing.
   */
  evaluate(incidentId: string): Promise<MonitorChange | undefined>;
  /** The `monitor.poll` handler. */
  poll(incidentId: string): Promise<PollReport>;
  /** The `timer.heartbeat` handler. */
  heartbeat(incidentId: string): Promise<HeartbeatOutcome>;
  /** The `timer.stall` handler. */
  stall(incidentId: string): Promise<StallOutcome>;
  /** `LadderDeps.stalled`: monitored, open, and no progress for `monitor.stallAfter`. */
  stalled(incident: Pick<IncidentView, 'id'>): Promise<boolean>;
  /** Registers the three handlers on the workflow port. */
  register(): void;
}

export function createActiveMonitor(deps: ActiveMonitorDeps): ActiveMonitor {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const ciSamples = deps.config?.ciSamples ?? DEFAULT_CI_SAMPLES;
  const ciHistory = deps.config?.ciHistory ?? DEFAULT_CI_HISTORY;

  let lastIntervalMs = DEFAULT_POLL_INTERVAL_MS;

  async function settings(): Promise<Timing & { critical: readonly string[] }> {
    const m = (await deps.playbook()).monitor;
    lastIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, parseDuration(m.interval));
    return {
      intervalMs: lastIntervalMs,
      heartbeatMs: Math.max(MIN_POLL_INTERVAL_MS, parseDuration(m.heartbeat)),
      stallAfterMs: parseDuration(m.stallAfter),
      critical: m.critical,
    };
  }

  async function cancelTimers(incidentId: string): Promise<void> {
    await deps.workflow.cancel(pollKey(incidentId));
    await deps.workflow.cancel(heartbeatKey(incidentId));
    await deps.workflow.cancel(stallKey(incidentId));
  }

  /** Schedules the heartbeat and stall timers at the times the log gives; the same log gives the same times. */
  async function armTimers(incidentId: string, log: readonly IncidentEvent[], timing: Timing): Promise<void> {
    const now = deps.clock().getTime();
    const data: MonitorTimerData = { incidentId };
    const beat = nextHeartbeat(log, timing.heartbeatMs, now);
    // A heartbeat that has just fallen due is either still queued or has run and queued the next; the
    // singleton schedule would replace either, so a re-arm inside the grace leaves it alone (#280).
    if (beat !== undefined && !heartbeatJustDue(log, timing.heartbeatMs, now)) await deps.workflow.schedule('timer.heartbeat', data, new Date(beat), { singletonKey: heartbeatKey(incidentId) });
    const anchor = stallAnchor(log);
    if (anchor !== undefined && anchor + timing.stallAfterMs > now) {
      await deps.workflow.schedule('timer.stall', data, new Date(anchor + timing.stallAfterMs), { singletonKey: stallKey(incidentId) });
    }
  }

  async function evaluateLadders(incidentId: string): Promise<void> {
    if (deps.ladders === undefined) return;
    try {
      await deps.ladders.evaluate(incidentId);
    } catch (e) {
      log(`active monitoring: incident ${incidentId}: escalation ladders: ${errorText(e)}`);
    }
  }

  /** Appends the start or stop the incident now calls for. Returns the change and the incident and log after it. */
  async function decide(incidentId: string, critical: readonly string[]): Promise<Decision | undefined> {
    for (let attempt = 1; ; attempt++) {
      const incident = await deps.state.getIncident(incidentId);
      if (incident === null) return undefined;
      const events = await deps.state.read(incidentId);
      const lastSeq = events.at(-1)?.seq ?? 0;
      if (lastSeq !== incident.lastSeq) {
        if (attempt >= MAX_APPEND_ATTEMPTS) throw new Error(`active monitoring: incident ${incidentId} kept moving`);
        continue;
      }
      if (isTerminalStatus(incident.status)) return { closed: true, incident, log: events };
      const change = monitoringChange(incident, events, critical);
      if (change === undefined) return { closed: false, incident, log: events };
      const event: NewEvent =
        'started' in change
          ? newEvent(deps, incidentId, 'monitoring-started', { qualifiedBy: change.started })
          : newEvent(deps, incidentId, 'monitoring-stopped', { reason: change.stopped });
      try {
        await deps.state.append(incidentId, [event], lastSeq);
      } catch (e) {
        if (!isExpectedSeqConflict(e) || attempt >= MAX_APPEND_ATTEMPTS) throw e;
        continue;
      }
      const after = (await deps.state.getIncident(incidentId)) ?? incident;
      return { change, closed: false, incident: after, log: await deps.state.read(incidentId) };
    }
  }

  /** When the incident is not monitored (closed, stopped, never started): cancels the timers and settles the ladders. */
  async function wind(d: Decision): Promise<void> {
    const id = d.incident.id;
    if (d.change !== undefined || d.log.some((e) => e.type === 'monitoring-started')) await cancelTimers(id);
    // The ladders read `monitored` and `closed`, which just changed or may have.
    if (d.change !== undefined || runningLadders(d.log).size > 0) await evaluateLadders(id);
  }

  async function evaluate(incidentId: string): Promise<MonitorChange | undefined> {
    const s = await settings();
    const d = await decide(incidentId, s.critical);
    if (d === undefined) return undefined;
    if (d.closed || !d.incident.monitored) {
      await wind(d);
      return d.change;
    }
    // Monitored (just started, or running: ours or the reaction ladder's outage start). Arming is idempotent:
    // `start` keeps a queued poll, and the timers are scheduled at the times the log gives.
    await deps.workflow.start('monitor.poll', { incidentId } satisfies MonitorTimerData, { singletonKey: pollKey(incidentId) });
    await armTimers(incidentId, d.log, s);
    if (d.change !== undefined) await evaluateLadders(incidentId);
    return d.change;
  }

  async function poll(incidentId: string): Promise<PollReport> {
    const report: PollReport = { monitored: false, appended: [], failures: [] };
    const s = await settings();
    const decided = await decide(incidentId, s.critical);
    if (decided === undefined) return report;
    if (decided.closed || !decided.incident.monitored) {
      await wind(decided);
      return report;
    }
    report.monitored = true;
    const incident = decided.incident;

    // The next poll first: a failing source must not end the chain.
    const data: MonitorTimerData = { incidentId };
    await deps.workflow.schedule('monitor.poll', data, new Date(deps.clock().getTime() + s.intervalMs), { singletonKey: pollKey(incidentId) });

    let answers: PolledAnswers | undefined;
    try {
      answers = await ask(deps.sources, incident, decided.log);
    } catch (error) {
      report.failures.push({ stage: 'source', error });
      log(`active monitoring: incident ${incidentId}: polling failed: ${errorText(error)}`);
    }

    if (answers !== undefined) {
      try {
        const appended = await appendMissing(incidentId, answers);
        report.appended.push(...appended);
      } catch (error) {
        report.failures.push({ stage: 'append', error });
        log(`active monitoring: incident ${incidentId}: append failed: ${errorText(error)}`);
      }
      if (report.appended.length > 0 && deps.followUp !== undefined) {
        const now = (await deps.state.getIncident(incidentId)) ?? incident;
        for (const event of report.appended) {
          try {
            await deps.followUp(event, now);
          } catch (error) {
            report.failures.push({ stage: 'follow-up', error });
            log(`active monitoring: incident ${incidentId}: follow-up for ${event.type} failed: ${errorText(error)}`);
          }
        }
      }
    }

    const events = await deps.state.read(incidentId);
    await armTimers(incidentId, events, s);
    if (decided.change !== undefined || runningLadders(events).size > 0 || isStalled(events, s.stallAfterMs, deps.clock().getTime())) {
      if (deps.ladders !== undefined) {
        try {
          await deps.ladders.evaluate(incidentId);
        } catch (error) {
          report.failures.push({ stage: 'ladders', error });
          log(`active monitoring: incident ${incidentId}: escalation ladders: ${errorText(error)}`);
        }
      }
    }
    return report;
  }

  async function appendMissing(incidentId: string, answers: PolledAnswers): Promise<IncidentEvent<PolledEventType>[]> {
    for (let attempt = 1; ; attempt++) {
      const incident = await deps.state.getIncident(incidentId);
      if (incident === null) return [];
      const before = await deps.state.read(incidentId);
      const lastSeq = before.at(-1)?.seq ?? 0;
      const events = [...(missingEvents(deps.clock, incident, answers, before) ?? []), ...missingDeploys(deps, incident, answers.deploys, before)];
      if (events.length === 0) return [];
      try {
        const { seq } = await deps.state.append(incidentId, events, lastSeq);
        const after = await deps.state.read(incidentId, lastSeq + 1);
        return after.filter((e) => e.seq <= seq && POLLED_TYPES.has(e.type)) as IncidentEvent<PolledEventType>[];
      } catch (e) {
        if (!isExpectedSeqConflict(e) || attempt >= MAX_APPEND_ATTEMPTS) throw e;
      }
    }
  }

  async function heartbeat(incidentId: string): Promise<HeartbeatOutcome> {
    const incident = await deps.state.getIncident(incidentId);
    if (incident === null || !incident.monitored || isTerminalStatus(incident.status)) return { posted: false, reason: 'not-monitored' };
    const s = await settings();
    const events = await deps.state.read(incidentId);
    const now = deps.clock().getTime();
    const base = heartbeatBase(events);
    if (base === undefined) return { posted: false, reason: 'not-monitored' };
    const n = Math.floor((now - base) / s.heartbeatMs);
    const next = new Date(base + (Math.max(n, 0) + 1) * s.heartbeatMs);
    // The next heartbeat first: a failing post must not end the chain.
    await deps.workflow.schedule('timer.heartbeat', { incidentId } satisfies MonitorTimerData, next, { singletonKey: heartbeatKey(incidentId) });
    if (n < 1) return { posted: false, reason: 'not-due', next };

    const status = statusAfter(events);
    const typical = status === 'ci' || status === 'ci-retry' ? await typicalCiMs(incident) : undefined;
    const text = heartbeatText(status, now - stageEnteredAt(events), typical);
    const where = threadOf(events, incident);
    if (where === undefined) {
      log(`active monitoring: incident ${incidentId} has no chat thread for the heartbeat`);
      return { posted: false, reason: 'no-thread', next };
    }
    try {
      await deps.chat.post({ incidentId, ladder: HEARTBEAT_LADDER, step: n, where, text });
    } catch (e) {
      log(`active monitoring: the heartbeat for incident ${incidentId} failed: ${errorText(e)}`);
      return { posted: false, reason: 'post-failed', next };
    }
    return { posted: true, text, next };
  }

  async function stall(incidentId: string): Promise<StallOutcome> {
    const incident = await deps.state.getIncident(incidentId);
    if (incident === null || !incident.monitored || isTerminalStatus(incident.status)) return { stalled: false };
    const s = await settings();
    const events = await deps.state.read(incidentId);
    const anchor = stallAnchor(events);
    if (anchor === undefined) return { stalled: false };
    const due = anchor + s.stallAfterMs;
    if (deps.clock().getTime() < due) {
      // Progress since this timer was set: wait for the new due time.
      const next = new Date(due);
      await deps.workflow.schedule('timer.stall', { incidentId } satisfies MonitorTimerData, next, { singletonKey: stallKey(incidentId) });
      return { stalled: false, next };
    }
    await evaluateLadders(incidentId);
    return { stalled: true };
  }

  async function stalled(ref: Pick<IncidentView, 'id'>): Promise<boolean> {
    const incident = await deps.state.getIncident(ref.id);
    if (incident === null || !incident.monitored || isTerminalStatus(incident.status)) return false;
    const s = await settings();
    return isStalled(await deps.state.read(ref.id), s.stallAfterMs, deps.clock().getTime());
  }

  /** Median of the repo's newest CI runs, from the log; undefined with none. */
  async function typicalCiMs(incident: IncidentView): Promise<number | undefined> {
    const repo = incident.repo;
    if (repo === undefined || repo === '') return undefined;
    const recent = await deps.state.findIncidents({ workspaceId: incident.workspaceId, limit: ciHistory });
    const runs: { at: number; ms: number }[] = [];
    for (const other of recent) {
      if (!sameRepo(other.repo, repo)) continue;
      runs.push(...ciRuns(await deps.state.read(other.id)));
    }
    return median(
      runs
        .sort((a, b) => b.at - a.at)
        .slice(0, ciSamples)
        .map((r) => r.ms),
    );
  }

  function handler(name: string, fn: (incidentId: string) => Promise<unknown>) {
    return async (job: { data: unknown }): Promise<void> => {
      if (!isMonitorTimerData(job.data)) throw new Error(`${name}: malformed job data`);
      await fn(job.data.incidentId);
    };
  }

  return {
    evaluate,
    poll,
    heartbeat,
    stall,
    stalled,
    register(): void {
      deps.workflow.work(
        'monitor.poll',
        handler('monitor.poll', async (incidentId) => {
          try {
            await poll(incidentId);
          } catch (e) {
            // Keep the chain: the next poll stops it if the incident is no longer monitored.
            await deps.workflow.schedule('monitor.poll', { incidentId } satisfies MonitorTimerData, new Date(deps.clock().getTime() + lastIntervalMs), {
              singletonKey: pollKey(incidentId),
            });
            throw e;
          }
        }),
      );
      deps.workflow.work('timer.heartbeat', handler('timer.heartbeat', heartbeat));
      deps.workflow.work('timer.stall', handler('timer.stall', stall));
    },
  };
}

// Pure helpers ------------------------------------------------------------------------------------

interface Timing {
  intervalMs: number;
  heartbeatMs: number;
  stallAfterMs: number;
}

interface Decision {
  change?: MonitorChange;
  closed: boolean;
  incident: IncidentView;
  log: IncidentEvent[];
}

interface PolledAnswers extends ReconcileAnswers {
  deploys?: DeployState[];
}

const POLLED_TYPES: ReadonlySet<EventType> = new Set<EventType>(['ci-green', 'ci-red', 'merged', 'jira-transitioned', 'deployed:staging', 'deployed:production']);

const MERGED_OR_LATER: ReadonlySet<LifecycleStatus> = new Set<LifecycleStatus>(['merged', 'deployed:staging', 'deployed:production', 'reverted']);
const AWAITING_DEPLOY: ReadonlySet<LifecycleStatus> = new Set<LifecycleStatus>(['merged', 'deployed:staging']);

/** Events that are not progress on the fix (see the file header). */
const NOT_PROGRESS: ReadonlySet<EventType> = new Set<EventType>([
  'escalation-ladder',
  'escalated',
  'monitoring-started',
  'monitoring-stopped',
  'status-message-posted',
  'bot-message-posted',
  'waiting-changed',
  'corrected',
  'comment',
  'text-signal',
  'jira-priority-changed',
]);

/** `monitor-poll:{incident}`: one poll chain per incident. Not a B 5 timer, so not a `timerKey`. */
export function pollKey(incidentId: string): string {
  return `monitor-poll:${keySegment(incidentId)}`;
}

export function heartbeatKey(incidentId: string): string {
  return timerKey('heartbeat', { incidentId });
}

export function stallKey(incidentId: string): string {
  return timerKey('stall', { incidentId });
}

export function isMonitorTimerData(v: unknown): v is MonitorTimerData {
  return typeof v === 'object' && v !== null && typeof (v as { incidentId?: unknown }).incidentId === 'string' && (v as { incidentId: string }).incidentId !== '';
}

/** Which A 4.5 rule qualifies the incident, considering only what happened after seq `since`. */
export function qualification(incident: Pick<IncidentView, 'priority' | 'surfaceId'>, log: readonly IncidentEvent[], critical: readonly string[], since = 0): QualifiedBy | undefined {
  if (isHighest(incident.priority) && (since === 0 || log.some((e) => e.seq > since && raisedToHighest(e)))) return 'priority';
  if (since === 0 ? escalationState(log).outage : log.some((e) => e.seq > since && e.type === 'escalated' && e.payload.outage === true)) return 'outage-score';
  if (since === 0 && incident.surfaceId !== undefined && critical.includes(incident.surfaceId)) return 'critical-surface';
  return undefined;
}

/** The start or stop an open incident calls for, given its row and log. */
export function monitoringChange(incident: Pick<IncidentView, 'monitored' | 'priority' | 'surfaceId'>, log: readonly IncidentEvent[], critical: readonly string[]): { started: QualifiedBy } | { stopped: MonitorStopReason } | undefined {
  if (incident.monitored) {
    const run = currentRun(log);
    if (run !== undefined && humanDowngradeAfter(log, run.seq)) return { stopped: 'downgraded' };
    return qualification(incident, log, critical) === undefined ? { stopped: 'disqualified' } : undefined;
  }
  const stop = latestOf(log, 'monitoring-stopped');
  const since = stop?.payload.reason === 'downgraded' ? stop.seq : 0;
  const by = qualification(incident, log, critical, since);
  return by === undefined ? undefined : { started: by };
}

/** The latest `monitoring-started` with no `monitoring-stopped` after it. */
function currentRun(log: readonly IncidentEvent[]): IncidentEvent<'monitoring-started'> | undefined {
  let run: IncidentEvent<'monitoring-started'> | undefined;
  for (const e of log) {
    if (e.type === 'monitoring-started') run = e;
    else if (e.type === 'monitoring-stopped') run = undefined;
  }
  return run;
}

/** A person lowered the priority after seq `since` (see the file header). */
export function humanDowngradeAfter(log: readonly IncidentEvent[], since: number): boolean {
  let priority: string | undefined;
  for (const e of log) {
    const before = priority;
    priority = priorityAfter(e, priority);
    if (e.seq <= since || e.type !== 'jira-priority-changed') continue;
    const from = e.payload.from ?? before;
    if (from === undefined) continue;
    const a = rank(from);
    const b = rank(e.payload.to);
    if (a !== undefined && b !== undefined ? b < a : isHighest(from) && !isHighest(e.payload.to)) return true;
  }
  return false;
}

function priorityAfter(e: IncidentEvent, current: string | undefined): string | undefined {
  if (e.type === 'planned') return e.payload.priority;
  if (e.type === 'jira-priority-changed') return e.payload.to;
  if (e.type === 'escalated' && e.payload.priority !== undefined) return e.payload.priority;
  return current;
}

function raisedToHighest(e: IncidentEvent): boolean {
  return (e.type === 'jira-priority-changed' && isHighest(e.payload.to)) || (e.type === 'escalated' && isHighest(e.payload.priority));
}

function isHighest(priority: string | undefined): boolean {
  return priority?.trim().toLowerCase() === 'highest';
}

function rank(priority: string): number | undefined {
  const i = PRIORITY_ORDER.findIndex((p) => p.toLowerCase() === priority.trim().toLowerCase());
  return i < 0 ? undefined : i;
}

function latestOf<T extends EventType>(log: readonly IncidentEvent[], type: T): IncidentEvent<T> | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e?.type === type) return e as IncidentEvent<T>;
  }
  return undefined;
}

/** When the agent learned of an event: the later of when it happened and when it was recorded. */
function seenAt(e: IncidentEvent): number {
  return Math.max(Date.parse(e.occurredAt), Date.parse(e.recordedAt));
}

/** The status the log folds to. */
function statusAfter(log: readonly IncidentEvent[]): LifecycleStatus {
  return log.reduce<LifecycleStatus>((s, e) => nextStatus(s, e), INITIAL_STATUS);
}

/** The event that moved the incident into its current status. */
function stageEvent(log: readonly IncidentEvent[]): IncidentEvent | undefined {
  let status = INITIAL_STATUS;
  let moved: IncidentEvent | undefined;
  for (const e of log) {
    const next = nextStatus(status, e);
    if (next !== status) moved = e;
    status = next;
  }
  return moved;
}

/** When the current stage began (`occurredAt` of the event that entered it). */
function stageEnteredAt(log: readonly IncidentEvent[]): number {
  const e = stageEvent(log) ?? log[0];
  return e === undefined ? 0 : Date.parse(e.occurredAt);
}

/** Heartbeats count from the later of the stage change and the run's start; undefined when not monitored. */
function heartbeatBase(log: readonly IncidentEvent[]): number | undefined {
  const run = currentRun(log);
  if (run === undefined) return undefined;
  const stage = stageEvent(log);
  return Math.max(seenAt(run), stage === undefined ? 0 : seenAt(stage));
}

/** How long after a period boundary a queued heartbeat is given to run before a re-arm may replace it. */
const HEARTBEAT_GRACE_MS = 30_000;

/** True when `now` is within the grace after a heartbeat boundary (not the base itself, which posts nothing). */
export function heartbeatJustDue(log: readonly IncidentEvent[], heartbeatMs: number, now: number): boolean {
  const base = heartbeatBase(log);
  if (base === undefined || now - base < heartbeatMs) return false;
  return (now - base) % heartbeatMs < Math.min(HEARTBEAT_GRACE_MS, heartbeatMs / 2);
}

/** The next heartbeat time after `now`, or undefined when not monitored. */
export function nextHeartbeat(log: readonly IncidentEvent[], heartbeatMs: number, now: number): number | undefined {
  const base = heartbeatBase(log);
  if (base === undefined) return undefined;
  const n = Math.max(0, Math.floor((now - base) / heartbeatMs));
  return base + (n + 1) * heartbeatMs;
}

/** The stall clock's start: the last progress, or the run's start when later; undefined when not monitored. */
export function stallAnchor(log: readonly IncidentEvent[]): number | undefined {
  const run = currentRun(log);
  if (run === undefined) return undefined;
  let last = seenAt(run);
  for (const e of log) if (e.seq > run.seq && !NOT_PROGRESS.has(e.type)) last = Math.max(last, seenAt(e));
  return last;
}

function isStalled(log: readonly IncidentEvent[], stallAfterMs: number, now: number): boolean {
  const anchor = stallAnchor(log);
  return anchor !== undefined && now - anchor >= stallAfterMs;
}

/** CI runs in one log: `review-passed` to the next `ci-green` or `ci-red`, timed by `occurredAt`. */
export function ciRuns(log: readonly IncidentEvent[]): { at: number; ms: number }[] {
  const runs: { at: number; ms: number }[] = [];
  let entered: number | undefined;
  for (const e of log) {
    if (e.type === 'review-passed') entered = Date.parse(e.occurredAt);
    else if ((e.type === 'ci-green' || e.type === 'ci-red') && entered !== undefined) {
      const at = Date.parse(e.occurredAt);
      if (at >= entered) runs.push({ at, ms: at - entered });
      entered = undefined;
    }
  }
  return runs;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** What each stage reads as in "Still <stage>, ...". Reporter-facing: no "PR", no branch. */
const STAGE_TEXT: Readonly<Record<LifecycleStatus, string>> = {
  captured: 'looking into it',
  assembling: 'looking into it',
  resolved: 'looking into it',
  deduped: 'looking into it',
  planned: 'filing it',
  filed: 'waiting for a fix to start',
  claimed: 'with the engineer on it',
  'human-fixing': 'with the engineer on it',
  fixing: 'working on a fix',
  'fixing-retry': 'working on a fix',
  'in-review': 'in review',
  'in-review-retry': 'in review',
  ci: 'in CI',
  'ci-retry': 'in CI',
  mergeable: 'waiting to merge',
  held: 'waiting to merge',
  merged: 'waiting for the deploy',
  'deployed:staging': 'on staging',
  'deployed:production': 'live, waiting to close',
  reverted: 'reverted',
  stopped: 'stopped',
  escalated: 'waiting for a person',
  closed: 'closed',
  'not-filed': 'closed',
  'not-a-bug': 'closed',
  'linked-to-existing': 'closed',
};

/** "Still in CI, 12 minutes; typical for this repo is 9. Watching." */
export function heartbeatText(status: LifecycleStatus, elapsedMs: number, typicalMs?: number): string {
  let typical = '';
  if (typicalMs !== undefined) {
    const minutes = Math.max(1, Math.round(typicalMs / 60_000));
    // "typical for this repo is 9" when both read in minutes; spelled out otherwise.
    typical = `; typical for this repo is ${minutes < 60 && elapsedMs < 3_600_000 ? String(minutes) : span(minutes * 60_000)}`;
  }
  return `Still ${STAGE_TEXT[status]}, ${span(elapsedMs)}${typical}. Watching.`;
}

function span(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000));
  const unit = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? '' : 's'}`;
  if (total < 60) return unit(total, 'minute');
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return minutes === 0 ? unit(hours, 'hour') : `${unit(hours, 'hour')} ${unit(minutes, 'minute')}`;
}

/** The originating thread: the captured thread, else the anchor message (as the ladders post). */
function threadOf(log: readonly IncidentEvent[], incident: IncidentView): { kind: 'thread'; channel: string; threadId?: string } | undefined {
  const channel = incident.channelId;
  if (channel === undefined || channel === '') return undefined;
  const threadId = latestOf(log, 'captured')?.payload.threadId ?? incident.anchorId;
  return threadId === undefined || threadId === '' ? { kind: 'thread', channel } : { kind: 'thread', channel, threadId };
}

async function ask(sources: MonitorSources, incident: IncidentView, log: readonly IncidentEvent[]): Promise<PolledAnswers> {
  const answers: PolledAnswers = {};
  const status = incident.status;
  if (incident.prNumber !== undefined) {
    const pr: PrRef = { incidentId: incident.id, prNumber: incident.prNumber, ...(incident.repo === undefined ? {} : { repo: incident.repo }) };
    if (incident.waitingOn?.kind === 'ci' || status === 'ci' || status === 'ci-retry') answers.checks = await sources.prChecks(pr);
    if (!MERGED_OR_LATER.has(status)) answers.pr = await sources.prState(pr);
  }
  const merged = latestOf(log, 'merged');
  if (sources.deployments !== undefined && AWAITING_DEPLOY.has(status) && merged !== undefined) {
    answers.deploys = await sources.deployments({
      incidentId: incident.id,
      mergeCommitSha: merged.payload.mergeCommitSha,
      ...(incident.repo === undefined ? {} : { repo: incident.repo }),
    });
  }
  return answers;
}

/** `deployed:staging`, then `deployed:production`, where the lifecycle takes them and the log lacks them. */
function missingDeploys(deps: Pick<ActiveMonitorDeps, 'workspaceId' | 'clock'>, incident: IncidentView, deploys: readonly DeployState[] | undefined, log: readonly IncidentEvent[]): NewEvent[] {
  if (deploys === undefined || deploys.length === 0) return [];
  const merged = latestOf(log, 'merged');
  if (merged === undefined) return [];
  const out: NewEvent[] = [];
  let status = statusAfter(log);
  for (const stage of ['staging', 'production'] as const) {
    const d = deploys.find((x) => x.stage === stage);
    if (d === undefined) continue;
    const event = newEvent(deps, incident.id, stage === 'staging' ? 'deployed:staging' : 'deployed:production', {
      commitSha: d.commitSha,
      ...(d.deploymentId === undefined ? {} : { deploymentId: d.deploymentId }),
    });
    if (d.deployedAt !== undefined && !Number.isNaN(Date.parse(d.deployedAt))) event.occurredAt = new Date(d.deployedAt).toISOString();
    const probe = { ...event, seq: 0, recordedAt: event.occurredAt } as IncidentEvent;
    if (!isValidTransition(status, probe)) continue;
    out.push(event);
    status = nextStatus(status, probe);
  }
  return out;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
