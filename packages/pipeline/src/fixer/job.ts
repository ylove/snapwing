// src/fixer/job.ts: the fixer job (main 10.1, main 10.4), its budget timer (B 5), and the failure
// degrade. Stop lives in stop.ts.
//
// Flow:
//   startFixer           starts `fixer.run` with the singleton key `fixer:{incident}`. The Jira
//                        In Progress webhook calls it (main 10.1), and the review job calls it with
//                        attempt 2 and the review artifact (main 11.1).
//   fixer.run            reads the log and refuses, appending nothing, when a `stopped` is newer
//                        than the last `filed`, when an engineer's claim holds the fixer (A 2.1,
//                        `claimHold` in engine/claims.ts: claimed before any fixer start and not yet
//                        handed back or released), when a run is still going, or when this attempt
//                        already ran since the last `filed`, or when the workspace instructions held the
//                        start and no person has asked for one since (below). Otherwise it loads the latest version of
//                        the implementation request `planned` references, mints the run id, appends
//                        `fixer-started { runId, harness, attempt }` (the refusals are decided again on
//                        the append's read), schedules `timer.fixer-budget` (key
//                        `fixer-budget:{incident}`) at now plus the configured wall clock (default
//                        PT30M), and only then calls `RunnerPort.runFixer`, so the fixer's first report
//                        always finds its run in the log (B 9). When `runFixer` rejects it
//                        appends `fixer-failed { reason: 'runner-error: ...', attempts: 0 }` and runs
//                        `handleFixerFailed`. When a stop or a budget expiry landed while the runner
//                        was starting (its cancel found no run then), it cancels the new run.
//                        Workspace instructions (A 6.3, A 6.4; merge/instructions.ts): before the first
//                        attempt that starts on the agent's own (level 2 or 3, no person asked since
//                        `filed`), `checkInstructions` asks whether an instruction holds the start. A
//                        hold appends `level-changed` to 0 (ticket-only) with `fixerHoldReason` (the
//                        status sentence and the handle to mention) and starts nothing. After it, only a
//                        person starts the fixer (`humanStartAfter`: a Jira transition, a Fix it tap, a
//                        claim handed back); that start wins and appends, after `fixer-started`,
//                        `level-changed` back to at most 2 with `instructions-overridden:` and the
//                        person as actor.
//   timer.fixer-budget   when its run is still the running one: appends `fixer-failed
//                        { reason: 'budget-exceeded' }`, cancels the run, then `handleFixerFailed`.
//   handleFixerDone      cancels the budget timer. The fixer API (B 9) calls it after `fixer-done`.
//   handleFixerFailed    for the latest `fixer-failed` from any source (the fixer API, the budget
//                        timer): cancels the budget timer, calls `FixerGitHub.markIncomplete` when the
//                        failure left a partial branch, and appends `level-changed` to
//                        min(level, 2) with the reason (main 10.4: "level 2 semantics regardless of
//                        the configured level"; a level 0 or 1 incident keeps its level, the event
//                        still records why a human now owns it). Idempotent: a `level-changed` after
//                        that `fixer-failed` whose reason starts with `fixer-failed:` means done.
//
// Every append passes `expectedSeq` and re-reads on a conflict. The fixer itself reports only through the fixer API (B 9); this module
// never sees its progress except through the log.

import type { ArtifactRef, AutonomyLevel, EventActor, EventPayloads, EventSource, EventType, IncidentEvent, NewEvent } from '../contracts/events.ts';
import { fixerRunKey, isFixerBudgetData, isFixerRunData, timerKey, type FixerBudgetData, type FixerRunData } from '../contracts/jobs.ts';
import { isExpectedSeqConflict } from '../contracts/state.ts';
import { claimHold } from '../engine/claims.ts';
import {
  checkInstructions,
  fixerHoldReason,
  INSTRUCTIONS_FIXER_HELD_LEVEL,
  INSTRUCTIONS_HELD_REASON_PREFIX,
  INSTRUCTIONS_OVERRIDDEN_REASON_PREFIX,
  type InstructionsCheck,
  type InstructionsGate,
  type InstructionsIncident,
} from '../merge/instructions.ts';
import type { IncidentView } from '../contracts/state.ts';
import type { FixerBudget, HarnessChoice, RunnerPort } from '../ports/runner.ts';
import type { StatePort } from '../ports/state.ts';
import type { WorkflowPort } from '../ports/workflow.ts';
import { parseDuration } from '../util/duration.ts';
import { repoFullName } from '../util/repo.ts';
import { ulid } from '../util/ulid.ts';

export const DEFAULT_FIXER_WALL_CLOCK = 'PT30M';
export const DEFAULT_FIXER_ATTEMPTS = 3;
export const BUDGET_EXCEEDED = 'budget-exceeded';
/** Prefix of the `fixer-failed` reason recorded when `RunnerPort.runFixer` rejects. */
export const RUNNER_ERROR_PREFIX = 'runner-error:';
/** Prefix of the `level-changed` reason that records a fixer failure's degrade. */
export const FIXER_FAILED_REASON_PREFIX = 'fixer-failed:';
/** The level a failed fixer degrades to (main 10.4). */
export const FIXER_FAILED_LEVEL: AutonomyLevel = 2;

/** Which repo and ticket a GitHub call is about. */
export interface FixerGitHubContext {
  incidentId: string;
  repo: string;
  issueKey?: string;
}

/** The GitHub side of the fixer's stop and failure paths (main 10.4); implemented in the app package. */
export interface FixerGitHub {
  /**
   * Opens a draft PR from `branch` labeled `fixer-incomplete`, or marks the branch's open PR draft and
   * labels it. Must be idempotent: a retried failure handler may call it twice for one branch.
   */
  markIncomplete(branch: string, ctx: FixerGitHubContext): Promise<void>;
  /** Comments on and closes PR `pr`. Must tolerate a PR that is already closed. */
  closePr(pr: number, comment: string, ctx: FixerGitHubContext): Promise<void>;
}

export interface FixerConfig {
  harness: HarnessChoice;
  /** ISO 8601 wall clock per run (main 10.4). Default `PT30M`. */
  wallClock?: string;
  /** Attempts the harness may make inside one run (main 10.4). Default 3. */
  attempts?: number;
}

export interface FixerDeps {
  /** The install's workspace (single tenant), stamped on every event. */
  workspaceId: string;
  state: StatePort;
  workflow: WorkflowPort;
  runner: RunnerPort;
  github: FixerGitHub;
  config: FixerConfig;
  clock: () => Date;
  /** The live workspace instructions and the model that applies them before a fixer start (A 6.4). Absent: no check. */
  instructionsGate?: InstructionsGate;
}

export function fixerBudget(config: FixerConfig): FixerBudget {
  return { wallClock: config.wallClock ?? DEFAULT_FIXER_WALL_CLOCK, attempts: config.attempts ?? DEFAULT_FIXER_ATTEMPTS };
}

/** The harness name `fixer-started` records: the adapter, or `generic:{templateId}`. */
export function harnessName(choice: HarnessChoice): string {
  return choice.adapter === 'generic' ? `generic:${choice.templateId}` : choice.adapter;
}

/** Registers the `fixer.run` and `timer.fixer-budget` handlers. */
export function registerFixerJobs(deps: FixerDeps): void {
  deps.workflow.work('fixer.run', async (job) => {
    if (!isFixerRunData(job.data)) throw new Error('fixer.run: malformed job data');
    await runFixerJob(deps, job.data);
  });
  deps.workflow.work('timer.fixer-budget', async (job) => {
    if (!isFixerBudgetData(job.data)) throw new Error('timer.fixer-budget: malformed job data');
    await fixerBudgetExpired(deps, job.data);
  });
}

/** Starts the incident's `fixer.run` job (main 10.1). A start while one is queued returns that job. */
export function startFixer(deps: Pick<FixerDeps, 'workflow'>, input: FixerRunData): Promise<{ jobId: string }> {
  const data: FixerRunData = {
    incidentId: input.incidentId,
    attempt: input.attempt,
    ...(input.reviewArtifact === undefined ? {} : { reviewArtifact: input.reviewArtifact }),
  };
  return deps.workflow.start('fixer.run', data, { singletonKey: fixerRunKey(input.incidentId) });
}

export type FixerRunOutcome =
  | { started: true; runId: string }
  | { started: false; reason: StartRefusal | 'not-filed' | 'no-request' | 'no-repo' | 'runner-failed' };

type StartRefusal = 'stopped' | 'claimed' | 'running' | 'attempt-done' | 'instructions-held';

/** The `fixer.run` handler. */
export async function runFixerJob(deps: FixerDeps, data: FixerRunData): Promise<FixerRunOutcome> {
  const { incidentId } = data;
  const log = await deps.state.read(incidentId);
  const refusal = refuseStart(log, data.attempt);
  if (refusal !== undefined) return { started: false, reason: refusal };

  const filed = latest(log, 'filed');
  if (filed === undefined) return { started: false, reason: 'not-filed' };
  const request = latestRequest(log);
  if (request === undefined) return { started: false, reason: 'no-request' };
  const artifact = await deps.state.getArtifact(request.artifactId);
  if (artifact.kind !== 'implementation-request') {
    throw new Error(`fixer.run: artifact ${artifact.id} is a ${artifact.kind}, not an implementation-request`);
  }
  const incident = await deps.state.getIncident(incidentId);
  const repo = incident?.repo;
  if (repo === undefined || repo === '') return { started: false, reason: 'no-repo' };

  // Instructions only ever hold a start the agent makes on its own; a person's start wins (A 6.4).
  const instructed: InstructionsCheck = instructionsApply(log, data.attempt)
    ? await checkInstructions(deps.instructionsGate, {
        step: 'fixer-start',
        now: deps.clock(),
        incident: instructionsIncident(log, incident),
        implementationRequest: artifact.body,
      })
    : { hold: false };

  const budget = fixerBudget(deps.config);
  const runId = ulid();
  // Set by the decision that appended nothing, or that appended the instructions hold instead of a start.
  const decided: { refused: StartRefusal } = { refused: 'stopped' };
  const appended = await appendDecided(deps.state, incidentId, (events) => {
    const again = refuseStart(events, data.attempt);
    if (again !== undefined) {
      decided.refused = again;
      return undefined;
    }
    if (instructed.hold && instructionsApply(events, data.attempt)) {
      decided.refused = 'instructions-held';
      const from = currentLevel(events) ?? 3;
      return [newEvent(deps, incidentId, 'level-changed', { from, to: INSTRUCTIONS_FIXER_HELD_LEVEL, reason: fixerHoldReason(instructed) })];
    }
    decided.refused = 'stopped';
    const started = newEvent(deps, incidentId, 'fixer-started', { runId, harness: harnessName(deps.config.harness), attempt: data.attempt });
    return [started, ...overrideEvents(deps, incidentId, events)];
  });
  if (!appended.appended || decided.refused === 'instructions-held') return { started: false, reason: decided.refused };

  // Scheduled before the start, so a start that hangs, or a worker that dies here, still ends in
  // `fixer-failed` when the budget runs out.
  const budgetData: FixerBudgetData = { incidentId, runId };
  const fireAt = new Date(deps.clock().getTime() + parseDuration(budget.wallClock));
  await deps.workflow.schedule('timer.fixer-budget', budgetData, fireAt, { singletonKey: fixerBudgetKey(incidentId) });

  try {
    await deps.runner.runFixer({
      runId,
      // The runner, its checkout, and the harness (`SNAPWING_REPO`) take `owner/name`, not the map's form.
      workItem: { id: incidentId, issueKey: incident?.jiraKey ?? filed.payload.jiraKey, repo: repoFullName(repo) },
      implementationRequestArtifactId: artifact.id,
      implementationRequestVersion: artifact.version,
      harness: deps.config.harness,
      budget,
      ...(data.reviewArtifact === undefined ? {} : { review: data.reviewArtifact }),
    });
  } catch (e) {
    await runnerFailed(deps, incidentId, runId, e);
    return { started: false, reason: 'runner-failed' };
  }

  // A stop or a budget expiry that landed while the runner was starting cancelled a run the runner
  // did not know yet; cancel it now that it does. A `fixer-done` or the fixer's own `fixer-failed`
  // is the run ending itself.
  const ended = runEnd(await deps.state.read(incidentId), runId);
  if (ended?.type === 'stopped' || (ended?.type === 'fixer-failed' && ended.source !== 'fixer')) {
    await deps.runner.cancel(runId);
  }
  if (ended?.type === 'stopped') {
    await deps.workflow.cancel(fixerBudgetKey(incidentId));
    return { started: false, reason: 'stopped' };
  }
  return { started: true, runId };
}

/** `runFixer` rejected: records `fixer-failed` for the run unless it already ended, then degrades. */
async function runnerFailed(deps: FixerDeps, incidentId: string, runId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await appendDecided(deps.state, incidentId, (events) =>
    activeRun(events)?.payload.runId === runId
      ? [newEvent(deps, incidentId, 'fixer-failed', { reason: `${RUNNER_ERROR_PREFIX} ${message}`, attempts: 0 })]
      : undefined,
  );
  // Also cancels the budget timer; a no-op when the run ended otherwise and that was handled.
  await handleFixerFailed(deps, incidentId);
}

export type BudgetOutcome = 'expired' | 'not-running';

/** The `timer.fixer-budget` handler: ends the run when it is still the one running. */
export async function fixerBudgetExpired(deps: FixerDeps, data: FixerBudgetData): Promise<BudgetOutcome> {
  const { incidentId, runId } = data;
  const appended = await appendDecided(deps.state, incidentId, (events) => {
    const run = activeRun(events);
    if (run === undefined || run.payload.runId !== runId) return undefined;
    const partialBranch = partialBranchOf(events, run);
    return [
      newEvent(deps, incidentId, 'fixer-failed', {
        reason: BUDGET_EXCEEDED,
        ...(partialBranch === undefined ? {} : { partialBranch }),
        attempts: run.payload.attempt,
      }),
    ];
  });
  if (!appended.appended) return 'not-running';
  // Recorded first, so the run's own late report finds it already finished (B 9).
  await deps.runner.cancel(runId);
  await handleFixerFailed(deps, incidentId);
  return 'expired';
}

/** After `fixer-done` (B 9): the run finished inside its budget. */
export async function handleFixerDone(deps: Pick<FixerDeps, 'workflow'>, incidentId: string): Promise<void> {
  await deps.workflow.cancel(fixerBudgetKey(incidentId));
}

export type FailedOutcome = { handled: false } | { handled: true; markedIncomplete?: string; level: { from: AutonomyLevel; to: AutonomyLevel } };

/**
 * After `fixer-failed` from any source (main 10.4): draft PR for a partial branch, then the degrade
 * to level 2 semantics as `level-changed`. A no-op when there is no failure or it was handled.
 */
export async function handleFixerFailed(deps: FixerDeps, incidentId: string): Promise<FailedOutcome> {
  await deps.workflow.cancel(fixerBudgetKey(incidentId));
  const log = await deps.state.read(incidentId);
  const failed = latest(log, 'fixer-failed');
  if (failed === undefined || degradeRecorded(log, failed)) return { handled: false };

  const branch = failed.payload.partialBranch;
  if (branch !== undefined && branch !== '') {
    await deps.github.markIncomplete(branch, await githubContext(deps.state, incidentId));
  }
  const appended = await appendDecided(deps.state, incidentId, (events) => {
    const last = latest(events, 'fixer-failed');
    if (last === undefined || degradeRecorded(events, last)) return undefined;
    return [newEvent(deps, incidentId, 'level-changed', { ...degrade(events), reason: `${FIXER_FAILED_REASON_PREFIX} ${last.payload.reason}` })];
  });
  if (!appended.appended) return { handled: false };
  return { handled: true, ...(branch === undefined || branch === '' ? {} : { markedIncomplete: branch }), level: degrade(appended.before) };
}

function degrade(events: readonly IncidentEvent[]): { from: AutonomyLevel; to: AutonomyLevel } {
  const from = currentLevel(events) ?? FIXER_FAILED_LEVEL;
  return { from, to: from < FIXER_FAILED_LEVEL ? from : FIXER_FAILED_LEVEL };
}

// Log reading, shared with stop.ts ---------------------------------------------------------------

export function fixerBudgetKey(incidentId: string): string {
  return timerKey('fixer-budget', { incidentId });
}

/** The latest event of `type`, or undefined. */
export function latest<T extends EventType>(events: readonly IncidentEvent[], type: T): IncidentEvent<T> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e !== undefined && e.type === type) return e as IncidentEvent<T>;
  }
  return undefined;
}

export function lastSeqOf(events: readonly IncidentEvent[], type: EventType): number {
  return latest(events, type)?.seq ?? 0;
}

/** A `stopped` newer than the last `filed`: the incident is stopped and no fixer may start. */
export function stoppedSinceFiled(events: readonly IncidentEvent[]): boolean {
  return lastSeqOf(events, 'stopped') > lastSeqOf(events, 'filed');
}

/** The latest `fixer-started` when no `fixer-done`, `fixer-failed`, or `stopped` follows it. */
export function activeRun(events: readonly IncidentEvent[]): IncidentEvent<'fixer-started'> | undefined {
  const run = latest(events, 'fixer-started');
  if (run === undefined) return undefined;
  const ended = events.some((e) => e.seq > run.seq && (e.type === 'fixer-done' || e.type === 'fixer-failed' || e.type === 'stopped'));
  return ended ? undefined : run;
}

/** The autonomy level in force: the last `level-changed`, else the plan's. */
export function currentLevel(events: readonly IncidentEvent[]): AutonomyLevel | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === 'level-changed') return e.payload.to;
    if (e?.type === 'planned') return e.payload.autonomyLevel;
  }
  return undefined;
}

/** The repo and ticket from the incidents row, which folds corrections in. */
export async function githubContext(state: StatePort, incidentId: string): Promise<FixerGitHubContext> {
  const incident = await state.getIncident(incidentId);
  const repo = incident?.repo;
  if (repo === undefined || repo === '') throw new Error(`fixer: incident ${incidentId} has no resolved repo`);
  return { incidentId, repo, ...(incident?.jiraKey === undefined ? {} : { issueKey: incident.jiraKey }) };
}

export function newEvent<T extends EventType>(
  deps: Pick<FixerDeps, 'workspaceId' | 'clock'>,
  incidentId: string,
  type: T,
  payload: EventPayloads[T],
  extra: { actor?: EventActor; source?: EventSource } = {},
): NewEvent<T> {
  const event = {
    workspaceId: deps.workspaceId,
    incidentId,
    type,
    v: 1,
    source: extra.source ?? 'agent',
    ...(extra.actor === undefined ? {} : { actor: extra.actor }),
    occurredAt: deps.clock().toISOString(),
    payload,
  };
  return event as unknown as NewEvent<T>;
}

/** Re-reads per decision on `ExpectedSeqConflictError`. */
const MAX_APPEND_ATTEMPTS = 8;

export type Decided = { appended: true; seq: number; before: IncidentEvent[] } | { appended: false; before: IncidentEvent[] };

/**
 * Reads the log, asks `decide` what to append (undefined appends nothing), and appends it at the read
 * seq. A conflict re-reads and decides again (CONTEXT.md rule 1).
 */
export async function appendDecided(
  state: StatePort,
  incidentId: string,
  decide: (events: IncidentEvent[]) => NewEvent[] | undefined,
): Promise<Decided> {
  for (let attempt = 1; ; attempt++) {
    const before = await state.read(incidentId);
    const events = decide(before);
    if (events === undefined || events.length === 0) return { appended: false, before };
    try {
      const { seq } = await state.append(incidentId, events, before.at(-1)?.seq ?? 0);
      return { appended: true, seq, before };
    } catch (e) {
      if (!isExpectedSeqConflict(e) || attempt >= MAX_APPEND_ATTEMPTS) throw e;
    }
  }
}

// Private ----------------------------------------------------------------------------------------

/** The event that ended run `runId` (`fixer-done`, `fixer-failed`, or `stopped`), if one has. */
function runEnd(events: readonly IncidentEvent[], runId: string): IncidentEvent | undefined {
  const started = events.find((e) => e.type === 'fixer-started' && e.payload.runId === runId);
  if (started === undefined) return undefined;
  return events.find((e) => e.seq > started.seq && (e.type === 'fixer-done' || e.type === 'fixer-failed' || e.type === 'stopped'));
}

function refuseStart(log: readonly IncidentEvent[], attempt: number): StartRefusal | undefined {
  if (stoppedSinceFiled(log)) return 'stopped';
  if (claimHold(log) !== undefined) return 'claimed';
  const held = instructionsFixerHold(log);
  if (held !== undefined && humanStartAfter(log, held.seq) === undefined) return 'instructions-held';
  if (activeRun(log) !== undefined) return 'running';
  const since = lastSeqOf(log, 'filed');
  const ran = log.some((e) => e.seq > since && e.type === 'fixer-started' && e.payload.attempt === attempt);
  return ran ? 'attempt-done' : undefined;
}

// Workspace instructions at the fixer start (A 6.4) ----------------------------------------------

/** The level a person's start after an instructions hold restores at most: a person merges what it opens. */
const OVERRIDE_MAX_LEVEL: AutonomyLevel = 2;

/**
 * The `level-changed` that held the fixer start for the instructions, when it is still the level in
 * force (no later `level-changed`) and came after the last `filed`.
 */
export function instructionsFixerHold(events: readonly IncidentEvent[]): IncidentEvent<'level-changed'> | undefined {
  const last = latest(events, 'level-changed');
  if (last === undefined || last.seq <= lastSeqOf(events, 'filed')) return undefined;
  return last.payload.reason.startsWith(INSTRUCTIONS_HELD_REASON_PREFIX) ? last : undefined;
}

/**
 * The latest request by a person to start the fixer after `seq`: a Jira transition (the In Progress
 * webhook or the reconciler starts the fixer on it), a Fix it tap, or a claim handed back. Agent
 * events carry no actor, so the agent's own Jira transition never counts.
 */
export function humanStartAfter(events: readonly IncidentEvent[], seq: number): IncidentEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e === undefined || e.seq <= seq) break;
    if (e.actor === undefined) continue;
    if (e.type === 'jira-transitioned' || e.type === 'let-agent-take' || (e.type === 'tapped' && e.payload.choice === 'approve_fix')) return e;
  }
  return undefined;
}

/** Whether this start asks the instructions: the first attempt, on the agent's own (level 2 or 3, nobody asked), not already held. */
function instructionsApply(events: readonly IncidentEvent[], attempt: number): boolean {
  if (attempt !== 1 || instructionsFixerHold(events) !== undefined) return false;
  const level = currentLevel(events);
  return level !== undefined && level >= 2 && humanStartAfter(events, lastSeqOf(events, 'filed')) === undefined;
}

/** After an instructions hold, the person's start restores the level (at most 2), recorded with them as actor. */
function overrideEvents(deps: Pick<FixerDeps, 'workspaceId' | 'clock'>, incidentId: string, events: readonly IncidentEvent[]): NewEvent[] {
  const held = instructionsFixerHold(events);
  const human = held === undefined ? undefined : humanStartAfter(events, held.seq);
  if (held === undefined || human?.actor === undefined) return [];
  const to = held.payload.from < OVERRIDE_MAX_LEVEL ? held.payload.from : OVERRIDE_MAX_LEVEL;
  const reason = `${INSTRUCTIONS_OVERRIDDEN_REASON_PREFIX} started by ${human.actor.id} (${human.type}) over the workspace instructions hold`;
  return [newEvent(deps, incidentId, 'level-changed', { from: held.payload.to, to, reason }, { actor: human.actor, source: human.source })];
}

/** What the instructions check sees about the incident: the row (corrections folded in), the report, the plan. */
export function instructionsIncident(log: readonly IncidentEvent[], incident: IncidentView | null | undefined): InstructionsIncident {
  const captured = latest(log, 'captured')?.payload;
  const planned = latest(log, 'planned')?.payload;
  const level = currentLevel(log);
  const fields: Record<string, string | undefined> = {
    issueKey: incident?.jiraKey ?? latest(log, 'filed')?.payload.jiraKey,
    summary: incident?.summary ?? planned?.summary,
    surfaceId: incident?.surfaceId,
    componentId: incident?.componentId,
    repo: incident?.repo,
    priority: incident?.priority ?? planned?.priority,
  };
  const known = Object.fromEntries(Object.entries(fields).filter((e): e is [string, string] => e[1] !== undefined && e[1] !== ''));
  return {
    ...known,
    ...(level === undefined ? {} : { level }),
    ...(captured === undefined ? {} : { reporter: { name: captured.reporter.name, role: captured.reporter.role }, report: captured.anchorText }),
  };
}

/** The implementation request the latest plan references. */
function latestRequest(log: readonly IncidentEvent[]): ArtifactRef | undefined {
  return latest(log, 'planned')?.payload.implementationRequest;
}

/**
 * What a cancelled run left behind: the branch its `branched` checkpoint named, when it got as far as
 * `pushed` or `pr-opened` (main 10.4: "anything already pushed stays on the branch").
 */
function partialBranchOf(events: readonly IncidentEvent[], run: IncidentEvent<'fixer-started'>): string | undefined {
  const checkpoints = events.filter((e): e is IncidentEvent<'fixer-checkpoint'> => e.seq > run.seq && e.type === 'fixer-checkpoint');
  if (!checkpoints.some((c) => c.payload.phase === 'pushed' || c.payload.phase === 'pr-opened')) return undefined;
  const branched = checkpoints.filter((c) => c.payload.phase === 'branched').at(-1)?.payload.detail;
  return branched === undefined || branched.trim() === '' ? undefined : branched.trim();
}

function degradeRecorded(events: readonly IncidentEvent[], failed: IncidentEvent<'fixer-failed'>): boolean {
  return events.some((e) => e.seq > failed.seq && e.type === 'level-changed' && e.payload.reason.startsWith(FIXER_FAILED_REASON_PREFIX));
}
